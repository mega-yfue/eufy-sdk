import { method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CommandContext } from "./types.js";
import type { Command } from "../../core/contracts.js";

/** `SET_PAYLOAD` sub-command that opens a SmartDrop's lid. */
const OPEN_LID_CMD = 2100;

/**
 * The lid-open frame: `SET_PAYLOAD` 2100 `{isOpen: 1, userIndex: 0}` on the device channel, `mValue3` 0,
 * level 2 only, and sealable with the AES-128-ECB key an RSA cipher negotiates.
 */
function openLid(ctx: CommandContext): Command {
  return {
    kind: "set-payload",
    cmd: OPEN_LID_CMD,
    payload: { isOpen: 1, userIndex: 0 },
    channel: ctx.channel,
    mValue3: 0,
    level2Sender: "set-payload",
  };
}

/**
 * Every `smart_drop` feature, declared once.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const SMART_DROP_MEMBERS = {
  /**
   * Opens the lid with `SET_PAYLOAD` 2100 at level 2. Verified on a standalone T8790, whose cipher has
   * only an RSA key: the frame sealed AES-128-ECB opened the lid, the same frame at level 1 did not.
   */
  openLid: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        sink.dispatch(openLid(ctx)),
    "Open the SmartDrop lid.",
  ),
} as const satisfies Members;

/** Bound SmartDrop controls — the object returned by `dev.smartDrop()`. */
export type SmartDropActions = Surface<typeof SMART_DROP_MEMBERS>;

/** `smart_drop` — a standalone SmartDrop (T8790) parcel box: open the lid. */
export const SMART_DROP: CapabilityModule = {
  capability: "smart_drop",
  description: "SmartDrop parcel box lid control.",
  members: SMART_DROP_MEMBERS,
  properties: propertiesOf(SMART_DROP_MEMBERS),
  detection: { detect: (record) => record.model === "T8790" && record.parentSn === undefined },
};
