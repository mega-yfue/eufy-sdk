/**
 * A capability-driven model for a discovered Anker Solix device — the Solix analogue of the eufy
 * `Device` model: ONE `SolixDevice` class, no per-model subclasses, and behaviour resolved from what
 * the device reports (its catalog category + record fields + live telemetry) rather than switched on
 * its model. Callers branch on {@link SolixDevice.has}(capability), never on the product code.
 *
 * `energyMeter()`'s reads come from the shared `members` engine ({@link SOLIX_ENERGY_METER_MEMBERS} +
 * `bindMembers`) and are evidence-gated, so a getter exists only once a live frame has carried its tag.
 * `identity` / `firmware` / `connectivity` are read-only projections of the device record, so they take
 * no telemetry and are answerable whenever the record carries the field.
 */
import { bindMembers } from "./capabilities/members.js";
import type { CapabilityStateReader, CommandContext } from "./capabilities/types.js";
import type { CommandSink } from "../core/contracts.js";
import {
  detectSolixCapabilities,
  SOLIX_ENERGY_METER_MEMBERS,
  type SolixCapability,
  type SolixEnergyMeterReads,
} from "./capabilities/solix.js";
import { buildModelIndex } from "./solix-catalog.js";
import { solixProductFamily, type SolixProductFamily } from "./solix-family.js";
import type { SolixDeviceRecord, SolixProductCategory, SolixSiteScene } from "../core/solix-types.js";

/**
 * The device record shape, re-exported from the model surface. It lives in `core/solix-types` so the
 * transport client can return it without crossing the transport↔model line.
 */
export type { SolixDeviceRecord } from "../core/solix-types.js";

export interface SolixIdentity {
  serial: string;
  productCode: string;
  /** Friendly name — the catalog marketing name if resolvable, else the record's alias/name. */
  name: string;
  /** Anker catalog category (e.g. "Accessory", "Portable Power Station"), if resolvable. */
  category?: string;
  /**
   * Normalized product family — the "what kind of thing is this" answer (power station, Solarbank,
   * smart meter, …), decorrelated from the marketing `category` string. See {@link SolixDevice.family}.
   */
  family: SolixProductFamily;
}
export interface SolixConnectivity {
  online: boolean;
  rssi?: number;
  ssid?: string;
}

/**
 * The `dev.energyMeter()` handle: the members-derived reads ({@link SolixEnergyMeterReads} —
 * `meterVoltageL1` is present only once a frame carrying its tag has landed). Every not-yet-named meter
 * quantity is read from {@link SolixDevice.telemetry} under its `channel_<hex tag>` key instead, which a
 * static members table cannot enumerate.
 */
export type SolixEnergyMeter = SolixEnergyMeterReads;

/** Options for {@link SolixDevice}. */
export interface SolixDeviceOptions {
  /** Catalog categories (from `SolixClient.getProductCatalog()`) — used to resolve name + category. */
  catalog?: SolixProductCategory[];
}

/** A no-op sink: Solix telemetry is read-only — no member here dispatches a command. */
const READ_ONLY_SINK: CommandSink = { dispatch: async () => {} };

/**
 * A discovered Solix device with resolved category + capabilities. Feed live telemetry with
 * {@link applyReading} (from {@link SolixMqtt}'s `reading` events) to populate value accessors.
 */
export class SolixDevice {
  readonly serial: string;
  readonly productCode: string;
  readonly record: SolixDeviceRecord;
  private readonly caps: Set<SolixCapability>;
  private readonly identity_: SolixIdentity;
  private values: Record<string, number> = {};

  constructor(record: SolixDeviceRecord, opts: SolixDeviceOptions = {}) {
    this.record = record;
    this.serial = record.device_sn;
    this.productCode = record.product_code;
    const label = opts.catalog ? buildModelIndex(opts.catalog).get(record.product_code) : undefined;
    this.identity_ = {
      serial: record.device_sn,
      productCode: record.product_code,
      name: label?.name ?? record.alias_name ?? record.device_name ?? record.product_code,
      category: label?.category,
      family: solixProductFamily({ product_code: record.product_code, category: label?.category }),
    };
    this.caps = detectSolixCapabilities(record, this.identity_.category);
  }

  /**
   * The device's {@link SolixProductFamily} — the classification a caller branches on to SORT devices
   * (a site's power stations vs its meters), the Solix analogue of eufy's `isHomeBase()`. Distinct from
   * {@link has}, which answers what the device can DO; family answers what KIND of device it is.
   */
  get family(): SolixProductFamily {
    return this.identity_.family;
  }

  /** All capabilities this device carries. */
  get capabilities(): SolixCapability[] {
    return [...this.caps];
  }

  /** Whether the device carries a capability — the only correct way to branch on behaviour. */
  has(capability: SolixCapability): boolean {
    return this.caps.has(capability);
  }

  /**
   * Merge a live telemetry reading (a `SolixMqtt` `reading` event) so accessors reflect it. Takes the
   * WHOLE reading, not just its values, and drops one addressed to a different device: the documented
   * wiring is `mqtt.on("reading", r => device.applyReading(r))`, and one MQTT stream carries every
   * watched meter on the account — so without this filter two meters would cross-feed each other's floats.
   * A reading with no `deviceSn` (a hand-built one) is accepted as-is.
   */
  applyReading(reading: { deviceSn?: string; values: Record<string, number> }): void {
    if (reading.deviceSn && reading.deviceSn !== this.serial) return;
    this.values = { ...this.values, ...reading.values };
  }

  /** All decoded float telemetry channels from the latest applied reading (raw, `channel_<tag>` keys). */
  telemetry(): Record<string, number> {
    return { ...this.values };
  }

  identity(): SolixIdentity {
    return { ...this.identity_ };
  }

  firmware(): { version: string } | undefined {
    return this.record.device_sw_version ? { version: this.record.device_sw_version } : undefined;
  }

  connectivity(): SolixConnectivity | undefined {
    if (!this.has("connectivity")) return undefined;
    const rssi = this.record.rssi != null ? Number(this.record.rssi) : undefined;
    return {
      online: !!this.record.wifi_online,
      rssi: Number.isFinite(rssi) ? rssi : undefined,
      ssid: this.record.wifi_name,
    };
  }

  /**
   * The members-derived `energyMeter` reads, or `undefined` when the device has no meter. Each getter is
   * installed only for a tag this device has actually reported, and reads `this.values` LIVE — a handle
   * held across an {@link applyReading} reflects the newer values. Getter INSTALLATION is fixed at the
   * time of this call, so re-call it to pick up a tag first seen since.
   */
  energyMeter(): SolixEnergyMeter | undefined {
    if (!this.has("energyMeter")) return undefined;
    return bindMembers(SOLIX_ENERGY_METER_MEMBERS, this.meterDeps());
  }

  /**
   * The {@link MemberDeps} the members engine needs: a read closure over the live values store, and the
   * evidence gate (`ctx.paramIds`) rebuilt from the ff09 tags this device has reported. No `codec` — the
   * codecs are eufy transport families and a Solix device belongs to none of them. The sink is a no-op:
   * Solix telemetry is read-only, no member here dispatches a command.
   */
  private meterDeps(): { ctx: CommandContext; sink: CommandSink; read: CapabilityStateReader } {
    const read: CapabilityStateReader = (name) => {
      const v = this.values[name];
      return v === undefined ? undefined : { name, paramType: 0, value: v, ts: Date.now() };
    };
    return { ctx: { channel: 0, paramIds: this.seenTags() }, sink: READ_ONLY_SINK, read };
  }

  /** The ff09 tags this device has reported, derived from the decoder's `channel_<hex>` keys. */
  private seenTags(): ReadonlySet<number> {
    const tags = new Set<number>();
    for (const key of Object.keys(this.values)) {
      const m = /^channel_([0-9a-f]+)$/.exec(key);
      if (m) tags.add(parseInt(m[1], 16));
    }
    return tags;
  }
}

/**
 * The minimum a client must offer to be discovered against — the two wire reads {@link discoverSolixDevices}
 * composes. Typed STRUCTURALLY (not as `SolixClient`) so the model layer never imports the transport
 * client: the hard `transport ⊥ model` rule forbids it, and a structural shape needs no import.
 */
export interface SolixDeviceReader {
  getDevices(): Promise<SolixDeviceRecord[]>;
  getProductCatalog(): Promise<SolixProductCategory[]>;
}

/**
 * Resolve the product catalog for a discovery: a caller-supplied `opts.catalog` short-circuits the wire
 * read, and a failed `getProductCatalog()` degrades to no categories (names/families just go unresolved,
 * never a thrown discovery). Shared by {@link discoverSolixDevices} and `discoverSolixSites` so that
 * "a failed catalog is non-fatal" decision lives in exactly one place.
 */
export function resolveSolixCatalog(
  client: SolixDeviceReader,
  opts: { catalog?: SolixProductCategory[] },
): Promise<SolixProductCategory[]> {
  return opts.catalog ? Promise.resolve(opts.catalog) : client.getProductCatalog().catch(() => []);
}

/**
 * Discover an account's Solix devices as capability-driven {@link SolixDevice} objects — the wire+model
 * composition (a transport read + the product catalog) that used to be `SolixClient.discoverDevices()`.
 * It lives in the model layer because it builds `SolixDevice`; the wire client (now `transport/http`)
 * cannot, and passing it structurally keeps the layers decorrelated. Feed live telemetry to each result
 * via `SolixDevice.applyReading`.
 */
export async function discoverSolixDevices(
  client: SolixDeviceReader,
  opts: { catalog?: SolixProductCategory[] } = {},
): Promise<SolixDevice[]> {
  const [records, catalog] = await Promise.all([client.getDevices(), resolveSolixCatalog(client, opts)]);
  return records.map((r) => new SolixDevice(r, { catalog }));
}

/** Coerce a scene field (string-on-the-wire) to a finite number, or `undefined`. */
function sceneNum(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Reduce a site "scene" snapshot to per-device telemetry readings — the BACKSTOP counterpart to the
 * realtime `ff09` decode. It emits the fields the scene reliably carries that the fast MQTT frame does
 * NOT: `batteryTemperature` (the realtime frame's BMS blob is empty, so `solixReadings` withholds it),
 * `batterySoc` (a cross-check/seed for the `0xa3` SOC), and `expansionPacks` — the count of ATTACHED
 * add-on battery packs (0 on a standalone main unit). Each reading is shaped exactly like a `SolixMqtt`
 * `reading` event — `{ deviceSn, values }` — so a caller can feed it straight into
 * {@link SolixDevice.applyReading} and broadcast it on the same path as a live frame. Entries with no
 * usable value are dropped.
 */
export function solarbankSceneReadings(scene: SolixSiteScene): { deviceSn: string; values: Record<string, number> }[] {
  const list = scene.solarbank_info?.solarbank_list ?? [];
  const out: { deviceSn: string; values: Record<string, number> }[] = [];
  for (const sb of list) {
    const deviceSn = typeof sb.device_sn === "string" ? sb.device_sn : undefined;
    if (!deviceSn) continue;
    const values: Record<string, number> = {};
    const temp = sceneNum(sb.bat_temperature);
    if (temp !== undefined) values.batteryTemperature = temp;
    const soc = sceneNum(sb.bat_soc);
    if (soc !== undefined) values.batterySoc = soc;
    const packs = sceneNum(sb.sub_package_num);
    if (packs !== undefined) values.expansionPacks = packs;
    if (Object.keys(values).length > 0) out.push({ deviceSn, values });
  }
  return out;
}
