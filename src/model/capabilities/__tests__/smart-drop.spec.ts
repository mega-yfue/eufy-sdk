import { type SmartDropActions } from "../smart-drop.js";
import { DeviceType } from "../../device-types.js";
import { bind } from "./bind.js";
import { detectCapabilities } from "../index.js";

describe("smart_drop capability", () => {
  it("is detected on a standalone T8790 only", () => {
    const record = { model: "T8790", deviceType: DeviceType.SMART_DROP };
    expect(detectCapabilities(record, "camera")).toContain("smart_drop");
    expect(detectCapabilities({ ...record, parentSn: "T8000P0000000000" }, "camera")).not.toContain("smart_drop");
    expect(detectCapabilities({ ...record, model: "T8791" }, "camera")).not.toContain("smart_drop");
  });

  it("opens the lid with a level-2 set-payload 2100 that the set-payload key may seal", async () => {
    const { acts, sent } = bind<SmartDropActions>("smart_drop", { channel: 0, codec: "camera", paramIds: new Set() });
    await acts.openLid();
    expect(sent).toEqual([
      {
        kind: "set-payload",
        cmd: 2100,
        payload: { isOpen: 1, userIndex: 0 },
        channel: 0,
        mValue3: 0,
        level2Sender: "set-payload",
      },
    ]);
  });
});
