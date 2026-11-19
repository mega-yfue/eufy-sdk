/**
 * AUTHORITATIVE param dictionary — the app's own decompiled constant names joined with a live
 * param-sweep of real owned devices.
 *
 * Two namespaces (params are per-transport, NOT globally unique):
 *  - SECURITY_PARAMS — eufy P2P param space (ids 1000+). **Membership is the observation**: an id is
 *    listed only because the sweep saw it on a real owned device, so the id is real/accepted.
 *  - CLEAN_PARAMS — RoboVac Tuya DP space (ids 1 and above), names from the cloud
 *    `get_product_data_point` data_point_list.
 *  - MOWER_PARAMS — robot-mower Tuya DP space, names from the mower's Tuya product schema.
 *
 * Which models reported an id, and the capture that named it, are in the commit that adds the entry.
 */
import type { PropertyValueType, ParamEncoding } from "./types.js";

/** One param definition in the dictionary. */
export interface ParamDef {
  /** Stable camelCase code-facing name. */
  name: string;
  type: PropertyValueType;
  /** How the wire value is encoded, when not a plain scalar (decode on read, encode on write). */
  encoding?: ParamEncoding;
}

/** eufy P2P security param space (ids 1000+). */
export const SECURITY_PARAMS: Record<number, ParamDef> = {
  0: {
    name: "single",
    type: "string",
  },
  1011: {
    name: "motionDetection",
    type: "bool",
  },
  1013: {
    name: "icNightVisionType",
    type: "bool",
  },
  1015: {
    name: "easSwitch",
    type: "bool",
  },
  1019: {
    name: "enableHdr",
    type: "bool",
  },
  1020: {
    name: "streamingQuality",
    type: "number",
  },
  1023: {
    name: "videoRecordQuality",
    type: "number",
  },
  1035: {
    name: "cameraSwitch",
    type: "bool",
  },
  1043: {
    name: "param1043",
    type: "bool",
  },
  1045: {
    name: "ledStatus",
    type: "bool",
  },
  1056: {
    name: "liveviewLedSwitch",
    type: "bool",
  },
  1067: {
    name: "param1067",
    type: "bool",
  },
  1069: {
    name: "deviceCrossCamAssistanceSwitch",
    type: "bool",
  },
  1070: {
    name: "deviceCrossCamInterval",
    type: "number",
  },
  1071: {
    name: "param1071",
    type: "string",
  },
  1074: {
    name: "version1074",
    type: "string",
  },
  1101: {
    name: "battery",
    type: "number",
  },
  1102: {
    name: "sdinfo",
    type: "number",
  },
  1103: {
    name: "cameraInfo",
    type: "number",
  },
  1113: {
    name: "param1113",
    type: "bool",
  },
  1131: {
    name: "deviceStatus",
    type: "bool",
  },
  1133: {
    name: "hubUpgrade",
    type: "bool",
  },
  1134: {
    name: "devUpgrade",
    type: "bool",
  },
  1135: {
    name: "tfcardStatus",
    type: "bool",
  },
  1138: {
    name: "batteryTemp",
    type: "number",
  },
  1140: {
    name: "hubStatus",
    type: "bool",
  },
  1141: {
    name: "rssi",
    type: "number",
  },
  1142: {
    name: "wifiRssi",
    type: "number",
  },
  1145: {
    name: "nasStreamSwithc",
    type: "bool",
  },
  1146: {
    name: "nasTestStream",
    type: "bool",
  },
  1148: {
    name: "custom1Action",
    type: "number",
  },
  1149: {
    name: "custom2Action",
    type: "bool",
  },
  1150: {
    name: "custom3Action",
    type: "bool",
  },
  1151: {
    name: "alarmMode",
    type: "bool",
  },
  1154: {
    name: "param1154",
    type: "bool",
  },
  1155: {
    name: "param1155",
    type: "number",
  },
  1157: {
    name: "homeActionTable",
    type: "string",
    encoding: "base64+json",
  },
  1158: {
    name: "awayActionTable",
    type: "string",
    encoding: "base64+json",
  },
  1159: {
    name: "jsDelayCustom1",
    type: "string",
    encoding: "base64+json",
  },
  1163: {
    name: "devHomekitStatus",
    type: "bool",
  },
  1166: {
    name: "alarmDelayHome",
    type: "bool",
  },
  1167: {
    name: "alarmDelayAway",
    type: "bool",
  },
  1168: {
    name: "alarmDelayCustom1",
    type: "bool",
  },
  1169: {
    name: "alarmDelayCustom2",
    type: "bool",
  },
  1170: {
    name: "alarmDelayCustom3",
    type: "bool",
  },
  1171: {
    name: "leavingDelayHome",
    type: "bool",
  },
  1172: {
    name: "leavingDelayAway",
    type: "bool",
  },
  1173: {
    name: "leavingDelayCustom1",
    type: "bool",
  },
  1174: {
    name: "leavingDelayCustom2",
    type: "bool",
  },
  1175: {
    name: "leavingDelayCustom3",
    type: "bool",
  },
  1176: {
    name: "ipAddress",
    type: "string",
  },
  1177: {
    name: "offAction",
    type: "number",
  },
  1178: {
    name: "alarmDelayOff",
    type: "bool",
  },
  1179: {
    name: "levaingDelayOff",
    type: "bool",
  },
  1180: {
    name: "param1180",
    type: "string",
    encoding: "base64+json",
  },
  1181: {
    name: "param1181",
    type: "bool",
  },
  1182: {
    name: "devCloudStatus",
    type: "bool",
  },
  1191: {
    name: "workingDays",
    type: "number",
  },
  1192: {
    name: "detectedEvents",
    type: "number",
  },
  1193: {
    name: "recordingDays",
    type: "number",
  },
  1197: {
    name: "param1197",
    type: "number",
  },
  1198: {
    name: "devBatteryHealthyV2",
    type: "number",
  },
  1200: {
    name: "language",
    type: "bool",
  },
  1202: {
    name: "devsToneFile",
    type: "bool",
  },
  1204: {
    name: "mdetectparam",
    type: "string",
    encoding: "base64+json",
  },
  1205: {
    name: "resolution",
    type: "bool",
  },
  1207: {
    name: "rotateImage",
    type: "bool",
  },
  1210: {
    name: "pirsensitivity",
    type: "number",
  },
  1214: {
    name: "devsOsd",
    type: "number",
  },
  1215: {
    name: "timeZone",
    type: "string",
  },
  1217: {
    name: "deviceName",
    type: "string",
  },
  1224: {
    name: "armingMode",
    type: "bool",
  },
  1225: {
    name: "homeAction",
    type: "number",
  },
  1229: {
    name: "param1229",
    type: "number",
  },
  1230: {
    name: "doorbellAudioVolume",
    type: "number",
  },
  1236: {
    name: "param1236",
    type: "bool",
  },
  1239: {
    name: "awayAction",
    type: "number",
  },
  1240: {
    name: "audioMicrophoneSwitch",
    type: "bool",
  },
  1241: {
    name: "audioSpeakerSwitch",
    type: "bool",
  },
  1243: {
    name: "pirTestMode",
    type: "number",
  },
  1246: {
    name: "indoorPowerMode",
    type: "number",
  },
  1249: {
    name: "recordDuration",
    type: "number",
  },
  1250: {
    name: "recordInterval",
    type: "number",
  },
  1251: {
    name: "recordAutoStop",
    type: "bool",
  },
  1252: {
    name: "motionDetectionType",
    type: "bool",
  },
  1253: {
    name: "timeSystem",
    type: "bool",
  },
  1254: {
    name: "jsonSchedule",
    type: "string",
    encoding: "base64+json",
  },
  1256: {
    name: "customMode",
    type: "string",
    encoding: "base64+json",
  },
  1257: {
    name: "param1257",
    type: "number",
  },
  1264: {
    name: "hbWifi",
    type: "string",
    encoding: "base64+json",
  },
  1265: {
    name: "wanMode",
    type: "bool",
  },
  1266: {
    name: "repeaterRssi",
    type: "bool",
  },
  1271: {
    name: "snoozeTime",
    type: "string",
    encoding: "base64+json",
  },
  1273: {
    name: "devMdRecord",
    type: "bool",
  },
  1276: {
    name: "motionSensitivity",
    type: "number",
  },
  1277: {
    name: "nightVisionType",
    type: "number",
  },
  1279: {
    name: "param1279",
    type: "bool",
  },
  1280: {
    name: "param1280",
    type: "number",
  },
  1281: {
    name: "hubAlarmTone",
    type: "number",
  },
  1282: {
    name: "hubNotifyAlarm",
    type: "bool",
  },
  1283: {
    name: "hubNotifyMode",
    type: "number",
  },
  1284: {
    name: "hubDisableRecord",
    type: "bool",
  },
  1285: {
    name: "hubForbidLiveStream",
    type: "number",
  },
  1286: {
    name: "recordQuality",
    type: "bool",
  },
  1287: {
    name: "nasSendSecurityPasswd",
    type: "string",
  },
  1288: {
    name: "doorbellAudioRecordingSwitch",
    type: "bool",
  },
  1289: {
    name: "pushEffect",
    type: "number",
  },
  1290: {
    name: "sensorOpenStatusAlert",
    type: "string",
    encoding: "base64+json",
  },
  1291: {
    name: "sensorDoorDailyCheck",
    type: "string",
    encoding: "base64+json",
  },
  1292: {
    name: "promptVolume",
    type: "number",
  },
  1293: {
    name: "powerCharge",
    type: "bool",
  },
  1294: {
    name: "memuShow",
    type: "number",
  },
  1295: {
    name: "privacyparam",
    type: "string",
    encoding: "base64+json",
  },
  1296: {
    name: "powerCode",
    type: "string",
  },
  // A camera answers a bare bitmask; a camera behind an NVR-class hub answers a JSON object carrying
  // it as `ai_detect_type` beside `ai_switch`, `ai_notification`, `ai_use_global` and `channel`.
  1298: {
    name: "aiDetectType",
    type: "string",
    encoding: "json",
  },
  // Cameras and a HomeBase 3 answer a bare number; a HomeBase S1 Pro (T9000) answers a JSON envelope
  // (`{"ai_switch":1,"smart_detection":…,"devlist":[…]}`).
  1299: {
    name: "hbAiDetectType",
    type: "string",
    encoding: "json",
  },
  1309: {
    name: "solarIntensity",
    type: "number",
  },
  1362: {
    name: "param1362",
    type: "bool",
  },
  1400: {
    name: "floodlightManualSwitch",
    type: "bool",
  },
  1401: {
    name: "floodlightBrightnessValue",
    type: "number",
  },
  1403: {
    name: "floodlightTotalSwitch",
    type: "bool",
  },
  1408: {
    name: "lightCtrlPirSwitch",
    type: "bool",
  },
  1410: {
    name: "floodlightColorTemperatureValue",
    type: "number",
  },
  1418: {
    name: "param1418",
    type: "bool",
  },
  1419: {
    name: "param1419",
    type: "string",
  },
  1420: {
    name: "param1420",
    type: "string",
  },
  1422: {
    name: "motionActivateLight",
    type: "string",
    encoding: "json",
  },
  1423: {
    name: "param1423",
    type: "number",
  },
  1506: {
    name: "param1506",
    type: "bool",
  },
  1507: {
    name: "alarmSoundType",
    type: "number",
  },
  1508: {
    name: "alarmVolumeValue",
    type: "number",
  },
  1509: {
    name: "param1509",
    type: "bool",
  },
  1510: {
    name: "param1510",
    type: "bool",
  },
  1511: {
    name: "param1511",
    type: "bool",
  },
  1512: {
    name: "param1512",
    type: "bool",
  },
  1513: {
    name: "param1513",
    type: "bool",
  },
  1550: {
    name: "contact",
    type: "bool",
  },
  1551: {
    name: "lastSeen",
    type: "number",
  },
  1552: {
    name: "entrySensorBatState",
    type: "bool",
  },
  1601: {
    name: "motionSensorBatState",
    type: "bool",
  },
  1605: {
    name: "motionSensorPirEvt",
    type: "number",
  },
  1607: {
    name: "param1607",
    type: "bool",
  },
  1608: {
    name: "param1608",
    type: "bool",
  },
  1609: {
    name: "motionSensorSetPirSensitivity",
    type: "number",
  },
  1653: {
    name: "keypadBatteryCapState",
    type: "bool",
  },
  1654: {
    name: "param1654",
    type: "bool",
  },
  1655: {
    name: "keypadBatteryChargerState",
    type: "number",
  },
  1663: {
    name: "param1663",
    type: "bool",
  },
  1670: {
    name: "keypadIsPswSet",
    type: "bool",
  },
  1702: {
    name: "batDoorbellChimeSwitch",
    type: "bool",
  },
  1703: {
    name: "batDoorbellMechanicalChimeSwitch",
    type: "bool",
  },
  1704: {
    name: "batDoorbellWdrSwitch",
    type: "bool",
  },
  1705: {
    name: "streamingQualityOther",
    type: "bool",
  },
  1708: {
    name: "doorbellRingtoneVolume",
    type: "number",
  },
  1709: {
    name: "batDoorbellSetElectronicRingtoneTime",
    type: "bool",
  },
  1710: {
    name: "doorbellSetNotificationMode",
    type: "string",
    encoding: "json",
  },
  1714: {
    name: "param1714",
    type: "bool",
  },
  1716: {
    name: "doorbellSetLedEnable",
    type: "bool",
  },
  1717: {
    name: "batDoorbellSetDingdongVolume",
    type: "number",
  },
  1718: {
    name: "batDoorbellSetDingdongRingtone",
    type: "number",
  },
  1719: {
    name: "batDoorbellSetOnlyUseAiAtNight",
    type: "bool",
  },
  1820: {
    name: "waterSensorWaterState",
    type: "bool",
  },
  1822: {
    name: "waterSensorTemperatureLow",
    type: "bool",
  },
  1823: {
    name: "smokeSensorLastSmokeEvt",
    type: "number",
  },
  1825: {
    name: "sirenSensorSetAlarmVol",
    type: "number",
  },
  1828: {
    name: "sensorNotDisturb",
    type: "bool",
  },
  1873: {
    name: "waterSensorTemperatureAlarm",
    type: "number",
  },
  2001: {
    name: "paramTypeOpenDevice",
    type: "string",
  },
  2002: {
    name: "paramTypeNightVisual",
    type: "string",
  },
  2031: {
    name: "vdbParameterVideoQuality",
    type: "bool",
  },
  2034: {
    name: "vdbParameterVideoRecordQuality",
    type: "number",
  },
  2104: {
    name: "param2104",
    type: "bool",
  },
  2105: {
    name: "smartDropGetStatus",
    type: "bool",
  },
  2106: {
    name: "param2106",
    type: "bool",
  },
  2107: {
    name: "param2107",
    type: "bool",
  },
  2109: {
    name: "param2109",
    type: "bool",
  },
  2111: {
    name: "batteryStatus",
    type: "number",
  },
  2123: {
    name: "param2123",
    type: "bool",
  },
  2700: {
    name: "mergeDownloadStatus",
    type: "number",
  },
  2706: {
    name: "dualcamSetRadarWdSwitch",
    type: "bool",
  },
  2707: {
    name: "dualcamSetRadarWdDistance",
    type: "string",
    encoding: "json",
  },
  2708: {
    name: "dualcamSetRadarWdTime",
    type: "string",
    encoding: "json",
  },
  2715: {
    name: "dualcamSetLingerGroup",
    type: "string",
    encoding: "json",
  },
  2730: {
    name: "multicamSetVideoQuailty",
    type: "string",
    encoding: "base64+json",
  },
  2731: {
    name: "multicamSetRecordQuailty",
    type: "string",
    encoding: "base64+json",
  },
  2733: {
    name: "pkgDetRecSwitch",
    type: "bool",
  },
  3100: {
    name: "batteryPowerDatas",
    type: "string",
    encoding: "json",
  },
  3103: {
    name: "continuousRecording",
    type: "bool",
  },
  5006: {
    name: "version5006",
    type: "string",
  },
  5007: {
    name: "version5007",
    type: "string",
  },
  5008: {
    name: "version5008",
    type: "string",
  },
  5009: {
    name: "version5009",
    type: "string",
  },
  5010: {
    name: "version5010",
    type: "string",
  },
  5011: {
    name: "version5011",
    type: "string",
  },
  5012: {
    name: "version5012",
    type: "string",
  },
  6000: {
    name: "lockStatus",
    type: "number",
  },
  6001: {
    name: "lockBattery",
    type: "number",
  },
  6010: {
    name: "pwList",
    type: "bool",
  },
  6011: {
    name: "statusInServer",
    type: "bool",
  },
  6012: {
    name: "statusInLock",
    type: "bool",
  },
  6013: {
    name: "updateUserTime",
    type: "string",
    encoding: "base64+json",
  },
  6014: {
    name: "updatePw",
    type: "bool",
  },
  6015: {
    name: "lockParam",
    type: "number",
  },
  6016: {
    name: "lockParam",
    type: "bool",
  },
  6020: {
    name: "notificationStyle",
    type: "number",
  },
  6022: {
    name: "fingerPwUsage",
    type: "bool",
  },
  6023: {
    name: "saveLockParamToServer",
    type: "bool",
  },
  6024: {
    name: "pullBle",
    type: "bool",
  },
  6025: {
    name: "indoorAiSoundEnable",
    type: "bool",
  },
  6026: {
    name: "shutDownBle",
    type: "bool",
  },
  6027: {
    name: "userIdAndPwId",
    type: "number",
  },
  6028: {
    name: "receiveSeqNum",
    type: "number",
  },
  6031: {
    name: "updateNfcName",
    type: "bool",
  },
  6037: {
    name: "indoorSpanCruiseSchedule",
    type: "string",
    encoding: "base64+json",
  },
  6040: {
    name: "indoorMotionEnable",
    type: "bool",
  },
  6041: {
    name: "indoorMotionDetectionSensitivity",
    type: "number",
  },
  6042: {
    name: "indoorDetSetActiveZone",
    type: "string",
    encoding: "base64+json",
  },
  6043: {
    name: "soundDetection",
    type: "bool",
  },
  6044: {
    name: "soundDetectionSensitivity",
    type: "number",
  },
  6045: {
    name: "indoorSetMotionDetectionType",
    type: "number",
  },
  6046: {
    name: "indoorDetSetSoundDetectType",
    type: "number",
  },
  6047: {
    name: "petCommandSwitch",
    type: "bool",
  },
  6049: {
    name: "indoorDetSetPetExpelRespIdx",
    type: "bool",
  },
  6050: {
    name: "nasVideoTypeEvent",
    type: "number",
  },
  6053: {
    name: "param6053",
    type: "bool",
  },
  6057: {
    name: "outdoorEventAiMark",
    type: "string",
    encoding: "base64+json",
  },
  6062: {
    name: "indoorHkGetHkBindStatus",
    type: "bool",
  },
  6070: {
    name: "motionDetectionSensitivitySolo",
    type: "number",
  },
  6073: {
    name: "pirSetting",
    type: "string",
    encoding: "json",
  },
  6080: {
    name: "indoorSpotEnable",
    type: "bool",
  },
  6081: {
    name: "indoorSpotAuto",
    type: "bool",
  },
  6082: {
    name: "indoorSpotBright",
    type: "number",
  },
  6086: {
    name: "indoorSpotSchedule",
    type: "bool",
  },
  6090: {
    name: "presetLeft",
    type: "bool",
  },
  6091: {
    name: "presetMid",
    type: "bool",
  },
  6092: {
    name: "presetRight",
    type: "bool",
  },
  6098: {
    name: "spanPirResponse",
    type: "bool",
  },
  6099: {
    name: "spanAutoCalibrate",
    type: "bool",
  },
  6200: {
    name: "wifiName",
    type: "string",
  },
  6201: {
    name: "presetZone",
    type: "string",
    encoding: "base64+json",
  },
  6204: {
    name: "param6204",
    type: "string",
    encoding: "base64+json",
  },
  6205: {
    name: "dualCamVideoType",
    type: "bool",
  },
  6206: {
    name: "commamdFgGetCurrentNetworkType",
    type: "bool",
  },
  6208: {
    name: "indoorRoundLookV2",
    type: "bool",
  },
  6210: {
    name: "presetLocation",
    type: "number",
  },
  6214: {
    name: "dualcamSetNotdetectobjectBack",
    type: "string",
    encoding: "base64+json",
  },
  6234: {
    name: "secondCamZoneHot",
    type: "string",
    encoding: "base64+json",
  },
  6243: {
    name: "videoAndRecordType",
    type: "bool",
  },
  6248: {
    name: "privacyZonesStatus",
    type: "bool",
  },
  6250: {
    name: "privacy",
    type: "bool",
  },
  6253: {
    name: "enableMotionInNight",
    type: "bool",
  },
  6254: {
    name: "testWiring",
    type: "number",
  },
  6257: {
    name: "preRecord",
    type: "bool",
  },
  6266: {
    name: "outOfViewActivityZone",
    type: "string",
    encoding: "base64+json",
  },
  6285: {
    name: "param6285",
    type: "bool",
  },
  6287: {
    name: "silentOtaSwitch",
    type: "bool",
  },
  6445: {
    name: "powerSourceInfo",
    type: "string",
    encoding: "json",
  },
  6456: {
    name: "param6456",
    type: "bool",
  },
  6458: {
    name: "voipSwitch",
    type: "bool",
  },
  6461: {
    name: "config6461",
    type: "string",
    encoding: "json",
  },
  6464: {
    name: "config6464",
    type: "string",
    encoding: "json",
  },
  6467: {
    name: "adaptiveBrightnessEnable",
    type: "bool",
  },
  6481: {
    name: "param6481",
    type: "bool",
  },
  6482: {
    name: "solarPanelConnect24h",
    type: "number",
  },
  6484: {
    name: "supplyLightMode",
    type: "bool",
  },
  7000: {
    name: "param7000",
    type: "bool",
  },
  7013: {
    name: "systemVersion",
    type: "string",
  },
  9208: {
    name: "imageHdr",
    type: "bool",
  },
  40003: {
    name: "rtspEnable",
    type: "bool",
  },
  40004: {
    name: "rtspRecordType",
    type: "bool",
  },
  40005: {
    name: "rtspRecordSupport",
    type: "bool",
  },
  40008: {
    name: "ipcLastHbSn",
    type: "string",
  },
  40010: {
    name: "param40010",
    type: "bool",
  },
  40011: {
    name: "param40011",
    type: "bool",
  },
  60001: {
    name: "wifiPwd",
    type: "string",
  },
  60009: {
    name: "mutiRouteConnect",
    type: "bool",
  },
  60011: {
    name: "devMutiSwitchEx",
    type: "bool",
  },
  61006: {
    name: "devAlarmTimeout",
    type: "number",
  },
  61008: {
    name: "devRingStatus",
    type: "bool",
  },
  61010: {
    name: "devPetStatus",
    type: "bool",
  },
  61015: {
    name: "devDisassemble",
    type: "bool",
  },
  61016: {
    name: "devEntryBypass",
    type: "bool",
  },
  99904: {
    name: "typePrivateMode",
    type: "bool",
  },
  100000: {
    name: "param100000",
    type: "bool",
  },
};

/** RoboVac Tuya DP space (ids ~150-180), from get_product_data_point. */
export const CLEAN_PARAMS: Record<number, ParamDef> = {
  150: {
    name: "protocol",
    type: "string",
  },
  151: {
    name: "power",
    type: "bool",
  },
  152: {
    name: "mode",
    type: "string",
  },
  153: {
    name: "workStatus",
    type: "string",
  },
  154: {
    name: "cleanParams",
    type: "string",
  },
  155: {
    name: "direction",
    type: "string",
  },
  156: {
    name: "resumeClean",
    type: "bool",
  },
  157: {
    name: "doNotDisturb",
    type: "string",
  },
  158: {
    name: "suction",
    type: "enum",
  },
  159: {
    name: "boostiq",
    type: "bool",
  },
  160: {
    name: "locate",
    type: "bool",
  },
  161: {
    name: "volume",
    type: "number",
  },
  162: {
    name: "language",
    type: "string",
  },
  163: {
    name: "battery",
    type: "number",
  },
  164: {
    name: "schedule",
    type: "string",
  },
  165: {
    name: "reserved2",
    type: "string",
  },
  166: {
    name: "debugSettings",
    type: "string",
  },
  167: {
    name: "cleanStats",
    type: "string",
  },
  168: {
    name: "consumables",
    type: "string",
  },
  169: {
    name: "appAndDevice",
    type: "string",
  },
  170: {
    name: "mapEdit",
    type: "string",
  },
  171: {
    name: "multiMapControl",
    type: "string",
  },
  172: {
    name: "multiMapManage",
    type: "string",
  },
  173: {
    name: "baseStation",
    type: "string",
  },
  174: {
    name: "mediaManage",
    type: "string",
  },
  175: {
    name: "reserved3",
    type: "string",
  },
  176: {
    name: "commonSettings",
    type: "string",
  },
  177: {
    name: "faultAlert",
    type: "string",
  },
  178: {
    name: "prompt",
    type: "string",
  },
  179: {
    name: "dataAnalysis",
    type: "string",
  },
  180: {
    name: "scene",
    type: "string",
  },
  // X8 Pro (T2266, eufy_home_tuya) Tuya DP schema — live-confirmed via getCurrentDps.
  // Source: thing.m.device.ref.info.list v5.4, product wahqax6ifjgs1c4n, schemaInfo.schema.
  1: {
    name: "power",
    type: "bool",
  },
  2: {
    name: "play_pause",
    type: "bool",
  },
  3: {
    name: "direction_control",
    type: "enum",
  },
  5: {
    name: "mode",
    type: "enum",
  },
  15: {
    name: "status",
    type: "enum",
  },
  101: {
    name: "go_home",
    type: "bool",
  },
  102: {
    name: "cleaning_strength",
    type: "enum",
  },
  103: {
    name: "look_for_sweeper",
    type: "bool",
  },
  104: {
    name: "battery_level",
    type: "number",
  },
  105: {
    name: "MopWater",
    type: "enum",
  },
  106: {
    name: "fault_report",
    type: "number",
  },
  107: {
    name: "forbid_mode",
    type: "bool",
  },
  109: {
    name: "ClearTime",
    type: "number",
  },
  110: {
    name: "ClearArea",
    type: "number",
  },
  111: {
    name: "Loudness",
    type: "number",
  },
  113: {
    name: "CleanType",
    type: "enum",
  },
  119: {
    name: "ClearTotalTime",
    type: "number",
  },
  120: {
    name: "ClearTotalArea",
    type: "number",
  },
  127: {
    name: "water_tank_status",
    type: "bool",
  },
  129: {
    name: "mop_status",
    type: "bool",
  },
  134: {
    name: "rssi",
    type: "number",
  },
};

/**
 * eufy Smart Display (T87Ax) param space — ids 8001-8006.
 *
 * Its own table rather than a corner of {@link SECURITY_PARAMS}: nothing in the 8000s carries a security
 * meaning, so reading these ids there would decode a future security param assigned in this range as
 * whatever it means on a camera.
 *
 * Every id here was reported by a live T87A0 (captured 2026-09-04); that the device SENT an id is what
 * earns it a place in this table. `modelName` and `modelCode` hold what the cloud record already carries.
 * `battery`'s name comes from the hardware's owner, not the cloud data-point list, and `"100"` fits
 * brightness, volume or charge equally.
 *
 * A dictionary entry is what makes a param readable by name off `getProperties()`. `capabilities/display.ts`
 * decides separately which of them reach the typed surface, and only `battery` does.
 *
 * **8002 (`"1"`) and 8004 (a serial-shaped string) are absent, deliberately.** Neither meaning is
 * legible from one value: `1` fits any enum or flag, and a serial could be the display's own or the
 * station's it is bound to. They arrive as `unknown_8002` / `unknown_8004`, which is the measure of this
 * list: it holds what is unknown, not what is unknowable. What would settle them: the vendor app's own
 * display settings screen, one control at a time, params diffed after each.
 */
export const DISPLAY_PARAMS: Record<number, ParamDef> = {
  8001: {
    name: "battery",
    type: "number",
  },
  8003: {
    name: "softwareVersion",
    type: "string",
  },
  8005: {
    name: "modelName",
    type: "string",
  },
  8006: {
    name: "modelCode",
    type: "string",
  },
};

/**
 * Robot-mower Tuya DP space — names from the E15's Tuya product schema (`schemaInfo.schema`), each id
 * also reported by a live E15. Only the scalar data points the `mower` capability reads are listed.
 */
export const MOWER_PARAMS: Record<number, ParamDef> = {
  8: {
    name: "battery",
    type: "number",
  },
  26: {
    name: "volume",
    type: "number",
  },
  47: {
    name: "childLock",
    type: "bool",
  },
  101: {
    name: "rainAutoReturn",
    type: "bool",
  },
  109: {
    name: "wifiSignal",
    type: "number",
  },
  110: {
    name: "cutHeight",
    type: "number",
  },
  118: {
    name: "mapSaveProgress",
    type: "number",
  },
  125: {
    name: "stationUsedTime",
    type: "number",
  },
  126: {
    name: "bladeUsedTime",
    type: "number",
  },
  128: {
    name: "edgeTrim",
    type: "bool",
  },
  130: {
    name: "workAngleEnabled",
    type: "bool",
  },
  131: {
    name: "workAngle",
    type: "number",
  },
  132: {
    name: "smartNoGoZones",
    type: "bool",
  },
  133: {
    name: "birdViewCapture",
    type: "bool",
  },
  134: {
    name: "network",
    type: "string",
  },
  137: {
    name: "cellularEnabled",
    type: "bool",
  },
  139: {
    name: "edgeDistance",
    type: "number",
  },
  140: {
    name: "gpsAntiTheft",
    type: "bool",
  },
  141: {
    name: "sparseLawnOptimization",
    type: "bool",
  },
};
