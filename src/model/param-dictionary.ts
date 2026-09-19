/**
 * AUTHORITATIVE param dictionary — the app's own decompiled constant names joined with a live
 * param-sweep of real owned devices.
 *
 * Two namespaces (params are per-transport, NOT globally unique):
 *  - SECURITY_PARAMS — eufy P2P param space (ids 1000+). **Membership is the observation**: an id is
 *    listed only because the sweep saw it on a real owned device, so the id is real/accepted.
 *    `provenance` is the trust of the NAME/meaning: "verified" (our captures) > "apk" (the app's own
 *    decompiled constant name) > "guessed" (no name source — needs toggle-diff).
 *  - CLEAN_PARAMS — RoboVac Tuya DP space (ids 1 and above), names from the cloud
 *    `get_product_data_point` data_point_list (provenance "mega" — authoritative).
 *
 * Which models reported an id, and the capture that named it, are in the commit that adds the entry.
 */
import type { PropertyValueType, PropertySource, ParamEncoding } from "./types.js";

/** One param definition in the dictionary. */
export interface ParamDef {
  /** Stable camelCase code-facing name. */
  name: string;
  type: PropertyValueType;
  provenance: PropertySource;
  /** How the wire value is encoded, when not a plain scalar (decode on read, encode on write). */
  encoding?: ParamEncoding;
}

/** eufy P2P security param space (ids 1000+). */
export const SECURITY_PARAMS: Record<number, ParamDef> = {
  0: {
    name: "single",
    type: "string",
    provenance: "apk",
  },
  1011: {
    name: "motionDetection",
    type: "bool",
    provenance: "verified",
  },
  1013: {
    name: "icNightVisionType",
    type: "bool",
    provenance: "apk",
  },
  1015: {
    name: "easSwitch",
    type: "bool",
    provenance: "apk",
  },
  1019: {
    name: "enableHdr",
    type: "bool",
    provenance: "apk",
  },
  1020: {
    name: "streamingQuality",
    type: "number",
    provenance: "apk",
  },
  1023: {
    name: "videoRecordQuality",
    type: "number",
    provenance: "apk",
  },
  1035: {
    name: "cameraSwitch",
    type: "bool",
    provenance: "apk",
  },
  1043: {
    name: "param1043",
    type: "bool",
    provenance: "guessed",
  },
  1045: {
    name: "ledStatus",
    type: "bool",
    provenance: "apk",
  },
  1056: {
    name: "liveviewLedSwitch",
    type: "bool",
    provenance: "apk",
  },
  1067: {
    name: "param1067",
    type: "bool",
    provenance: "guessed",
  },
  1069: {
    name: "deviceCrossCamAssistanceSwitch",
    type: "bool",
    provenance: "apk",
  },
  1070: {
    name: "deviceCrossCamInterval",
    type: "number",
    provenance: "apk",
  },
  1071: {
    name: "param1071",
    type: "string",
    provenance: "guessed",
  },
  1074: {
    name: "version1074",
    type: "string",
    provenance: "guessed",
  },
  1101: {
    name: "battery",
    type: "number",
    provenance: "verified",
  },
  1102: {
    name: "sdinfo",
    type: "number",
    provenance: "apk",
  },
  1103: {
    name: "cameraInfo",
    type: "number",
    provenance: "apk",
  },
  1113: {
    name: "param1113",
    type: "bool",
    provenance: "guessed",
  },
  1131: {
    name: "deviceStatus",
    type: "bool",
    provenance: "apk",
  },
  1133: {
    name: "hubUpgrade",
    type: "bool",
    provenance: "apk",
  },
  1134: {
    name: "devUpgrade",
    type: "bool",
    provenance: "apk",
  },
  1135: {
    name: "tfcardStatus",
    type: "bool",
    provenance: "apk",
  },
  1138: {
    name: "batteryTemp",
    type: "number",
    provenance: "apk",
  },
  1140: {
    name: "hubStatus",
    type: "bool",
    provenance: "apk",
  },
  1141: {
    name: "rssi",
    type: "number",
    provenance: "verified",
  },
  1142: {
    name: "wifiRssi",
    type: "number",
    provenance: "apk",
  },
  1145: {
    name: "nasStreamSwithc",
    type: "bool",
    provenance: "apk",
  },
  1146: {
    name: "nasTestStream",
    type: "bool",
    provenance: "apk",
  },
  1148: {
    name: "custom1Action",
    type: "number",
    provenance: "apk",
  },
  1149: {
    name: "custom2Action",
    type: "bool",
    provenance: "apk",
  },
  1150: {
    name: "custom3Action",
    type: "bool",
    provenance: "apk",
  },
  1151: {
    name: "alarmMode",
    type: "bool",
    provenance: "apk",
  },
  1154: {
    name: "param1154",
    type: "bool",
    provenance: "guessed",
  },
  1155: {
    name: "param1155",
    type: "number",
    provenance: "guessed",
  },
  1157: {
    name: "jsDelayHome",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  1159: {
    name: "jsDelayCustom1",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  1163: {
    name: "devHomekitStatus",
    type: "bool",
    provenance: "apk",
  },
  1166: {
    name: "alarmDelayHome",
    type: "bool",
    provenance: "apk",
  },
  1167: {
    name: "alarmDelayAway",
    type: "bool",
    provenance: "apk",
  },
  1168: {
    name: "alarmDelayCustom1",
    type: "bool",
    provenance: "apk",
  },
  1169: {
    name: "alarmDelayCustom2",
    type: "bool",
    provenance: "apk",
  },
  1170: {
    name: "alarmDelayCustom3",
    type: "bool",
    provenance: "apk",
  },
  1171: {
    name: "leavingDelayHome",
    type: "bool",
    provenance: "apk",
  },
  1172: {
    name: "leavingDelayAway",
    type: "bool",
    provenance: "apk",
  },
  1173: {
    name: "leavingDelayCustom1",
    type: "bool",
    provenance: "apk",
  },
  1174: {
    name: "leavingDelayCustom2",
    type: "bool",
    provenance: "apk",
  },
  1175: {
    name: "leavingDelayCustom3",
    type: "bool",
    provenance: "apk",
  },
  1176: {
    name: "ipAddress",
    type: "string",
    provenance: "apk",
  },
  1177: {
    name: "offAction",
    type: "number",
    provenance: "apk",
  },
  1178: {
    name: "alarmDelayOff",
    type: "bool",
    provenance: "apk",
  },
  1179: {
    name: "levaingDelayOff",
    type: "bool",
    provenance: "apk",
  },
  1180: {
    name: "param1180",
    type: "string",
    provenance: "guessed",
    encoding: "base64+json",
  },
  1181: {
    name: "param1181",
    type: "bool",
    provenance: "guessed",
  },
  1182: {
    name: "devCloudStatus",
    type: "bool",
    provenance: "apk",
  },
  1191: {
    name: "workingDays",
    type: "number",
    provenance: "apk",
  },
  1192: {
    name: "detectedEvents",
    type: "number",
    provenance: "apk",
  },
  1193: {
    name: "recordingDays",
    type: "number",
    provenance: "apk",
  },
  1197: {
    name: "param1197",
    type: "number",
    provenance: "guessed",
  },
  1198: {
    name: "devBatteryHealthyV2",
    type: "number",
    provenance: "apk",
  },
  1200: {
    name: "language",
    type: "bool",
    provenance: "apk",
  },
  1202: {
    name: "devsToneFile",
    type: "bool",
    provenance: "apk",
  },
  1204: {
    name: "mdetectparam",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  1205: {
    name: "resolution",
    type: "bool",
    provenance: "apk",
  },
  1207: {
    name: "rotateImage",
    type: "bool",
    provenance: "verified",
  },
  1210: {
    name: "pirsensitivity",
    type: "number",
    provenance: "apk",
  },
  1214: {
    name: "devsOsd",
    type: "number",
    provenance: "apk",
  },
  1215: {
    name: "timeZone",
    type: "string",
    provenance: "apk",
  },
  1217: {
    name: "deviceName",
    type: "string",
    provenance: "apk",
  },
  1224: {
    name: "armingMode",
    type: "bool",
    provenance: "verified",
  },
  1225: {
    name: "homeAction",
    type: "number",
    provenance: "apk",
  },
  1229: {
    name: "param1229",
    type: "number",
    provenance: "guessed",
  },
  1230: {
    name: "doorbellAudioVolume",
    type: "number",
    provenance: "apk",
  },
  1236: {
    name: "param1236",
    type: "bool",
    provenance: "guessed",
  },
  1239: {
    name: "awayAction",
    type: "number",
    provenance: "apk",
  },
  1240: {
    name: "audioMicrophoneSwitch",
    type: "bool",
    provenance: "apk",
  },
  1241: {
    name: "audioSpeakerSwitch",
    type: "bool",
    provenance: "apk",
  },
  1243: {
    name: "pirTestMode",
    type: "number",
    provenance: "apk",
  },
  1246: {
    name: "indoorPowerMode",
    type: "number",
    provenance: "apk",
  },
  1249: {
    name: "recordDuration",
    type: "number",
    provenance: "apk",
  },
  1250: {
    name: "recordInterval",
    type: "number",
    provenance: "apk",
  },
  1251: {
    name: "recordAutoStop",
    type: "bool",
    provenance: "apk",
  },
  1252: {
    name: "motionDetectionType",
    type: "bool",
    provenance: "apk",
  },
  1253: {
    name: "timeSystem",
    type: "bool",
    provenance: "apk",
  },
  1254: {
    name: "jsonSchedule",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  1256: {
    name: "customMode",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  1257: {
    name: "param1257",
    type: "number",
    provenance: "guessed",
  },
  1264: {
    name: "hbWifi",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  1265: {
    name: "wanMode",
    type: "bool",
    provenance: "apk",
  },
  1266: {
    name: "repeaterRssi",
    type: "bool",
    provenance: "apk",
  },
  1271: {
    name: "snoozeTime",
    type: "string",
    provenance: "verified",
    encoding: "base64+json",
  },
  1273: {
    name: "devMdRecord",
    type: "bool",
    provenance: "apk",
  },
  1276: {
    name: "motionSensitivity",
    type: "number",
    provenance: "verified",
  },
  1277: {
    name: "nightVisionType",
    type: "number",
    provenance: "apk",
  },
  1279: {
    name: "param1279",
    type: "bool",
    provenance: "guessed",
  },
  1280: {
    name: "param1280",
    type: "number",
    provenance: "guessed",
  },
  1281: {
    name: "hubAlarmTone",
    type: "number",
    provenance: "verified",
  },
  1282: {
    name: "hubNotifyAlarm",
    type: "bool",
    provenance: "apk",
  },
  1283: {
    name: "hubNotifyMode",
    type: "number",
    provenance: "apk",
  },
  1284: {
    name: "hubDisableRecord",
    type: "bool",
    provenance: "apk",
  },
  1285: {
    name: "hubForbidLiveStream",
    type: "number",
    provenance: "apk",
  },
  1286: {
    name: "recordQuality",
    type: "bool",
    provenance: "apk",
  },
  1287: {
    name: "nasSendSecurityPasswd",
    type: "string",
    provenance: "apk",
  },
  1288: {
    name: "doorbellAudioRecordingSwitch",
    type: "bool",
    provenance: "apk",
  },
  1289: {
    name: "pushEffect",
    type: "number",
    provenance: "apk",
  },
  1290: {
    name: "sensorOpenStatusAlert",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  1291: {
    name: "sensorDoorDailyCheck",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  1292: {
    name: "promptVolume",
    type: "number",
    provenance: "apk",
  },
  1293: {
    name: "powerCharge",
    type: "bool",
    provenance: "apk",
  },
  1294: {
    name: "memuShow",
    type: "number",
    provenance: "apk",
  },
  1295: {
    name: "privacyparam",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  1296: {
    name: "powerCode",
    type: "string",
    provenance: "apk",
  },
  1298: {
    name: "aiDetectType",
    type: "number",
    provenance: "apk",
  },
  1299: {
    name: "hbAiDetectType",
    type: "number",
    provenance: "apk",
  },
  1309: {
    name: "solarIntensity",
    type: "number",
    provenance: "apk",
  },
  1362: {
    name: "param1362",
    type: "bool",
    provenance: "guessed",
  },
  1400: {
    name: "floodlightManualSwitch",
    type: "bool",
    provenance: "apk",
  },
  1401: {
    name: "floodlightBrightnessValue",
    type: "number",
    provenance: "apk",
  },
  1403: {
    name: "floodlightTotalSwitch",
    type: "bool",
    provenance: "apk",
  },
  1408: {
    name: "lightCtrlPirSwitch",
    type: "bool",
    provenance: "apk",
  },
  1410: {
    name: "floodlightColorTemperatureValue",
    type: "number",
    provenance: "apk",
  },
  1418: {
    name: "param1418",
    type: "bool",
    provenance: "guessed",
  },
  1419: {
    name: "param1419",
    type: "string",
    provenance: "guessed",
  },
  1420: {
    name: "param1420",
    type: "string",
    provenance: "guessed",
  },
  1422: {
    name: "motionActivateLight",
    type: "string",
    provenance: "apk",
    encoding: "json",
  },
  1423: {
    name: "param1423",
    type: "number",
    provenance: "guessed",
  },
  1506: {
    name: "param1506",
    type: "bool",
    provenance: "guessed",
  },
  1507: {
    name: "alarmSoundType",
    type: "number",
    provenance: "verified",
  },
  1508: {
    name: "alarmVolumeValue",
    type: "number",
    provenance: "verified",
  },
  1509: {
    name: "param1509",
    type: "bool",
    provenance: "guessed",
  },
  1510: {
    name: "param1510",
    type: "bool",
    provenance: "guessed",
  },
  1511: {
    name: "param1511",
    type: "bool",
    provenance: "guessed",
  },
  1512: {
    name: "param1512",
    type: "bool",
    provenance: "guessed",
  },
  1513: {
    name: "param1513",
    type: "bool",
    provenance: "guessed",
  },
  1550: {
    name: "contact",
    type: "bool",
    provenance: "verified",
  },
  1551: {
    name: "lastSeen",
    type: "number",
    provenance: "verified",
  },
  1552: {
    name: "entrySensorBatState",
    type: "bool",
    provenance: "apk",
  },
  1601: {
    name: "motionSensorBatState",
    type: "bool",
    provenance: "apk",
  },
  1605: {
    name: "motionSensorPirEvt",
    type: "number",
    provenance: "apk",
  },
  1607: {
    name: "param1607",
    type: "bool",
    provenance: "guessed",
  },
  1608: {
    name: "param1608",
    type: "bool",
    provenance: "guessed",
  },
  1609: {
    name: "motionSensorSetPirSensitivity",
    type: "number",
    provenance: "apk",
  },
  1653: {
    name: "keypadBatteryCapState",
    type: "bool",
    provenance: "apk",
  },
  1654: {
    name: "param1654",
    type: "bool",
    provenance: "guessed",
  },
  1655: {
    name: "keypadBatteryChargerState",
    type: "number",
    provenance: "apk",
  },
  1663: {
    name: "param1663",
    type: "bool",
    provenance: "guessed",
  },
  1670: {
    name: "keypadIsPswSet",
    type: "bool",
    provenance: "apk",
  },
  1702: {
    name: "batDoorbellChimeSwitch",
    type: "bool",
    provenance: "apk",
  },
  1703: {
    name: "batDoorbellMechanicalChimeSwitch",
    type: "bool",
    provenance: "verified",
  },
  1704: {
    name: "batDoorbellWdrSwitch",
    type: "bool",
    provenance: "verified",
  },
  1705: {
    name: "streamingQualityOther",
    type: "bool",
    provenance: "apk",
  },
  1708: {
    name: "doorbellRingtoneVolume",
    type: "number",
    provenance: "apk",
  },
  1709: {
    name: "batDoorbellSetElectronicRingtoneTime",
    type: "bool",
    provenance: "apk",
  },
  1710: {
    name: "doorbellSetNotificationMode",
    type: "string",
    provenance: "apk",
    encoding: "json",
  },
  1714: {
    name: "param1714",
    type: "bool",
    provenance: "guessed",
  },
  1716: {
    name: "doorbellSetLedEnable",
    type: "bool",
    provenance: "apk",
  },
  1717: {
    name: "batDoorbellSetDingdongVolume",
    type: "number",
    provenance: "verified",
  },
  1718: {
    name: "batDoorbellSetDingdongRingtone",
    type: "number",
    provenance: "verified",
  },
  1719: {
    name: "batDoorbellSetOnlyUseAiAtNight",
    type: "bool",
    provenance: "apk",
  },
  1825: {
    name: "sirenSensorSetAlarmVol",
    type: "number",
    provenance: "verified",
  },
  1828: {
    name: "sensorNotDisturb",
    type: "bool",
    provenance: "apk",
  },
  2001: {
    name: "paramTypeOpenDevice",
    type: "string",
    provenance: "apk",
  },
  2002: {
    name: "paramTypeNightVisual",
    type: "string",
    provenance: "apk",
  },
  2031: {
    name: "vdbParameterVideoQuality",
    type: "bool",
    provenance: "apk",
  },
  2034: {
    name: "vdbParameterVideoRecordQuality",
    type: "number",
    provenance: "apk",
  },
  2104: {
    name: "param2104",
    type: "bool",
    provenance: "guessed",
  },
  2105: {
    name: "smartDropGetStatus",
    type: "bool",
    provenance: "apk",
  },
  2106: {
    name: "param2106",
    type: "bool",
    provenance: "guessed",
  },
  2107: {
    name: "param2107",
    type: "bool",
    provenance: "guessed",
  },
  2109: {
    name: "param2109",
    type: "bool",
    provenance: "guessed",
  },
  2111: {
    name: "batteryStatus",
    type: "number",
    provenance: "apk",
  },
  2123: {
    name: "param2123",
    type: "bool",
    provenance: "guessed",
  },
  2700: {
    name: "mergeDownloadStatus",
    type: "number",
    provenance: "apk",
  },
  2706: {
    name: "dualcamSetRadarWdSwitch",
    type: "bool",
    provenance: "apk",
  },
  2707: {
    name: "dualcamSetRadarWdDistance",
    type: "string",
    provenance: "apk",
    encoding: "json",
  },
  2708: {
    name: "dualcamSetRadarWdTime",
    type: "string",
    provenance: "apk",
    encoding: "json",
  },
  2715: {
    name: "dualcamSetLingerGroup",
    type: "string",
    provenance: "apk",
    encoding: "json",
  },
  2730: {
    name: "multicamSetVideoQuailty",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  2731: {
    name: "multicamSetRecordQuailty",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  2733: {
    name: "pkgDetRecSwitch",
    type: "bool",
    provenance: "apk",
  },
  3100: {
    name: "batteryPowerDatas",
    type: "string",
    provenance: "apk",
    encoding: "json",
  },
  3103: {
    name: "continuousRecording",
    type: "bool",
    provenance: "apk",
  },
  5006: {
    name: "version5006",
    type: "string",
    provenance: "guessed",
  },
  5007: {
    name: "version5007",
    type: "string",
    provenance: "guessed",
  },
  5008: {
    name: "version5008",
    type: "string",
    provenance: "guessed",
  },
  5009: {
    name: "version5009",
    type: "string",
    provenance: "guessed",
  },
  5010: {
    name: "version5010",
    type: "string",
    provenance: "guessed",
  },
  5011: {
    name: "version5011",
    type: "string",
    provenance: "guessed",
  },
  5012: {
    name: "version5012",
    type: "string",
    provenance: "guessed",
  },
  6000: {
    name: "lockStatus",
    type: "number",
    provenance: "verified",
  },
  6001: {
    name: "lockBattery",
    type: "number",
    provenance: "verified",
  },
  6010: {
    name: "pwList",
    type: "bool",
    provenance: "apk",
  },
  6011: {
    name: "statusInServer",
    type: "bool",
    provenance: "apk",
  },
  6012: {
    name: "statusInLock",
    type: "bool",
    provenance: "apk",
  },
  6013: {
    name: "updateUserTime",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  6014: {
    name: "updatePw",
    type: "bool",
    provenance: "apk",
  },
  6015: {
    name: "lockParam",
    type: "number",
    provenance: "apk",
  },
  6016: {
    name: "lockParam",
    type: "bool",
    provenance: "apk",
  },
  6020: {
    name: "notificationStyle",
    type: "number",
    provenance: "verified",
  },
  6022: {
    name: "fingerPwUsage",
    type: "bool",
    provenance: "apk",
  },
  6023: {
    name: "saveLockParamToServer",
    type: "bool",
    provenance: "apk",
  },
  6024: {
    name: "pullBle",
    type: "bool",
    provenance: "apk",
  },
  6025: {
    name: "indoorAiSoundEnable",
    type: "bool",
    provenance: "apk",
  },
  6026: {
    name: "shutDownBle",
    type: "bool",
    provenance: "apk",
  },
  6027: {
    name: "userIdAndPwId",
    type: "number",
    provenance: "apk",
  },
  6028: {
    name: "receiveSeqNum",
    type: "number",
    provenance: "apk",
  },
  6031: {
    name: "updateNfcName",
    type: "bool",
    provenance: "apk",
  },
  6037: {
    name: "indoorSpanCruiseSchedule",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  6040: {
    name: "indoorMotionEnable",
    type: "bool",
    provenance: "apk",
  },
  6041: {
    name: "indoorMotionDetectionSensitivity",
    type: "number",
    provenance: "apk",
  },
  6042: {
    name: "indoorDetSetActiveZone",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  6043: {
    name: "soundDetection",
    type: "bool",
    provenance: "apk",
  },
  6044: {
    name: "soundDetectionSensitivity",
    type: "number",
    provenance: "apk",
  },
  6045: {
    name: "indoorSetMotionDetectionType",
    type: "number",
    provenance: "apk",
  },
  6046: {
    name: "indoorDetSetSoundDetectType",
    type: "number",
    provenance: "apk",
  },
  6047: {
    name: "petCommandSwitch",
    type: "bool",
    provenance: "apk",
  },
  6049: {
    name: "indoorDetSetPetExpelRespIdx",
    type: "bool",
    provenance: "apk",
  },
  6050: {
    name: "nasVideoTypeEvent",
    type: "number",
    provenance: "apk",
  },
  6053: {
    name: "param6053",
    type: "bool",
    provenance: "guessed",
  },
  6057: {
    name: "outdoorEventAiMark",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  6062: {
    name: "indoorHkGetHkBindStatus",
    type: "bool",
    provenance: "apk",
  },
  6070: {
    name: "motionDetectionSensitivitySolo",
    type: "number",
    provenance: "apk",
  },
  6073: {
    name: "pirSetting",
    type: "string",
    provenance: "apk",
    encoding: "json",
  },
  6080: {
    name: "indoorSpotEnable",
    type: "bool",
    provenance: "apk",
  },
  6081: {
    name: "indoorSpotAuto",
    type: "bool",
    provenance: "apk",
  },
  6082: {
    name: "indoorSpotBright",
    type: "number",
    provenance: "apk",
  },
  6086: {
    name: "indoorSpotSchedule",
    type: "bool",
    provenance: "apk",
  },
  6090: {
    name: "presetLeft",
    type: "bool",
    provenance: "apk",
  },
  6091: {
    name: "presetMid",
    type: "bool",
    provenance: "apk",
  },
  6092: {
    name: "presetRight",
    type: "bool",
    provenance: "apk",
  },
  6098: {
    name: "spanPirResponse",
    type: "bool",
    provenance: "apk",
  },
  6099: {
    name: "spanAutoCalibrate",
    type: "bool",
    provenance: "apk",
  },
  6200: {
    name: "wifiName",
    type: "string",
    provenance: "apk",
  },
  6201: {
    name: "presetZone",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  6204: {
    name: "param6204",
    type: "string",
    provenance: "guessed",
    encoding: "base64+json",
  },
  6205: {
    name: "dualCamVideoType",
    type: "bool",
    provenance: "apk",
  },
  6206: {
    name: "commamdFgGetCurrentNetworkType",
    type: "bool",
    provenance: "apk",
  },
  6208: {
    name: "indoorRoundLookV2",
    type: "bool",
    provenance: "apk",
  },
  6210: {
    name: "presetLocation",
    type: "number",
    provenance: "apk",
  },
  6214: {
    name: "dualcamSetNotdetectobjectBack",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  6234: {
    name: "secondCamZoneHot",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  6243: {
    name: "videoAndRecordType",
    type: "bool",
    provenance: "apk",
  },
  6248: {
    name: "privacyZonesStatus",
    type: "bool",
    provenance: "apk",
  },
  6250: {
    name: "privacy",
    type: "bool",
    provenance: "apk",
  },
  6253: {
    name: "enableMotionInNight",
    type: "bool",
    provenance: "apk",
  },
  6254: {
    name: "testWiring",
    type: "number",
    provenance: "apk",
  },
  6257: {
    name: "preRecord",
    type: "bool",
    provenance: "apk",
  },
  6266: {
    name: "outOfViewActivityZone",
    type: "string",
    provenance: "apk",
    encoding: "base64+json",
  },
  6285: {
    name: "param6285",
    type: "bool",
    provenance: "guessed",
  },
  6287: {
    name: "silentOtaSwitch",
    type: "bool",
    provenance: "apk",
  },
  6445: {
    name: "powerSourceInfo",
    type: "string",
    provenance: "apk",
    encoding: "json",
  },
  6456: {
    name: "param6456",
    type: "bool",
    provenance: "guessed",
  },
  6458: {
    name: "voipSwitch",
    type: "bool",
    provenance: "apk",
  },
  6461: {
    name: "config6461",
    type: "string",
    provenance: "guessed",
    encoding: "json",
  },
  6464: {
    name: "config6464",
    type: "string",
    provenance: "guessed",
    encoding: "json",
  },
  6467: {
    name: "adaptiveBrightnessEnable",
    type: "bool",
    provenance: "apk",
  },
  6481: {
    name: "param6481",
    type: "bool",
    provenance: "guessed",
  },
  6482: {
    name: "solarPanelConnect24h",
    type: "number",
    provenance: "apk",
  },
  6484: {
    name: "supplyLightMode",
    type: "bool",
    provenance: "apk",
  },
  7000: {
    name: "param7000",
    type: "bool",
    provenance: "guessed",
  },
  7013: {
    name: "systemVersion",
    type: "string",
    provenance: "verified",
  },
  9208: {
    name: "imageHdr",
    type: "bool",
    provenance: "apk",
  },
  40003: {
    name: "rtspEnable",
    type: "bool",
    provenance: "apk",
  },
  40004: {
    name: "rtspRecordType",
    type: "bool",
    provenance: "apk",
  },
  40005: {
    name: "rtspRecordSupport",
    type: "bool",
    provenance: "apk",
  },
  40008: {
    name: "ipcLastHbSn",
    type: "string",
    provenance: "apk",
  },
  40010: {
    name: "param40010",
    type: "bool",
    provenance: "guessed",
  },
  40011: {
    name: "param40011",
    type: "bool",
    provenance: "guessed",
  },
  60001: {
    name: "wifiPwd",
    type: "string",
    provenance: "apk",
  },
  60009: {
    name: "mutiRouteConnect",
    type: "bool",
    provenance: "apk",
  },
  60011: {
    name: "devMutiSwitchEx",
    type: "bool",
    provenance: "apk",
  },
  61006: {
    name: "devAlarmTimeout",
    type: "number",
    provenance: "verified",
  },
  61008: {
    name: "devRingStatus",
    type: "bool",
    provenance: "verified",
  },
  61010: {
    name: "devPetStatus",
    type: "bool",
    provenance: "apk",
  },
  61015: {
    name: "devDisassemble",
    type: "bool",
    provenance: "apk",
  },
  61016: {
    name: "devEntryBypass",
    type: "bool",
    provenance: "apk",
  },
  99904: {
    name: "typePrivateMode",
    type: "bool",
    provenance: "apk",
  },
  100000: {
    name: "param100000",
    type: "bool",
    provenance: "guessed",
  },
};

/** RoboVac Tuya DP space (ids ~150-180), from get_product_data_point. */
export const CLEAN_PARAMS: Record<number, ParamDef> = {
  150: {
    name: "protocol",
    type: "string",
    provenance: "mega",
  },
  151: {
    name: "power",
    type: "bool",
    provenance: "mega",
  },
  152: {
    name: "mode",
    type: "string",
    provenance: "mega",
  },
  153: {
    name: "workStatus",
    type: "string",
    provenance: "mega",
  },
  154: {
    name: "cleanParams",
    type: "string",
    provenance: "mega",
  },
  155: {
    name: "direction",
    type: "enum",
    provenance: "mega",
  },
  156: {
    name: "resumeClean",
    type: "bool",
    provenance: "mega",
  },
  157: {
    name: "doNotDisturb",
    type: "string",
    provenance: "mega",
  },
  158: {
    name: "suction",
    type: "enum",
    provenance: "mega",
  },
  159: {
    name: "boostiq",
    type: "bool",
    provenance: "mega",
  },
  160: {
    name: "locate",
    type: "bool",
    provenance: "mega",
  },
  161: {
    name: "volume",
    type: "number",
    provenance: "mega",
  },
  162: {
    name: "language",
    type: "string",
    provenance: "mega",
  },
  163: {
    name: "battery",
    type: "number",
    provenance: "mega",
  },
  164: {
    name: "schedule",
    type: "string",
    provenance: "mega",
  },
  165: {
    name: "reserved2",
    type: "string",
    provenance: "mega",
  },
  166: {
    name: "debugSettings",
    type: "string",
    provenance: "mega",
  },
  167: {
    name: "cleanStats",
    type: "string",
    provenance: "mega",
  },
  168: {
    name: "consumables",
    type: "string",
    provenance: "mega",
  },
  169: {
    name: "appAndDevice",
    type: "string",
    provenance: "mega",
  },
  170: {
    name: "mapEdit",
    type: "string",
    provenance: "mega",
  },
  171: {
    name: "multiMapControl",
    type: "string",
    provenance: "mega",
  },
  172: {
    name: "multiMapManage",
    type: "string",
    provenance: "mega",
  },
  173: {
    name: "baseStation",
    type: "string",
    provenance: "mega",
  },
  174: {
    name: "mediaManage",
    type: "string",
    provenance: "mega",
  },
  175: {
    name: "reserved3",
    type: "string",
    provenance: "mega",
  },
  176: {
    name: "commonSettings",
    type: "string",
    provenance: "mega",
  },
  177: {
    name: "faultAlert",
    type: "string",
    provenance: "mega",
  },
  178: {
    name: "prompt",
    type: "string",
    provenance: "mega",
  },
  179: {
    name: "dataAnalysis",
    type: "string",
    provenance: "mega",
  },
  180: {
    name: "scene",
    type: "string",
    provenance: "mega",
  },
  // X8 Pro (T2266, eufy_home_tuya) Tuya DP schema — live-confirmed via getCurrentDps.
  // Source: thing.m.device.ref.info.list v5.4, product wahqax6ifjgs1c4n, schemaInfo.schema.
  1: {
    name: "power",
    type: "bool",
    provenance: "mega",
  },
  2: {
    name: "play_pause",
    type: "bool",
    provenance: "mega",
  },
  3: {
    name: "direction_control",
    type: "enum",
    provenance: "mega",
  },
  5: {
    name: "mode",
    type: "enum",
    provenance: "mega",
  },
  15: {
    name: "status",
    type: "enum",
    provenance: "mega",
  },
  101: {
    name: "go_home",
    type: "bool",
    provenance: "mega",
  },
  102: {
    name: "cleaning_strength",
    type: "enum",
    provenance: "mega",
  },
  103: {
    name: "look_for_sweeper",
    type: "bool",
    provenance: "mega",
  },
  104: {
    name: "battery_level",
    type: "number",
    provenance: "mega",
  },
  105: {
    name: "MopWater",
    type: "enum",
    provenance: "mega",
  },
  106: {
    name: "fault_report",
    type: "number",
    provenance: "mega",
  },
  107: {
    name: "forbid_mode",
    type: "bool",
    provenance: "mega",
  },
  109: {
    name: "ClearTime",
    type: "number",
    provenance: "mega",
  },
  110: {
    name: "ClearArea",
    type: "number",
    provenance: "mega",
  },
  111: {
    name: "Loudness",
    type: "number",
    provenance: "mega",
  },
  113: {
    name: "CleanType",
    type: "enum",
    provenance: "mega",
  },
  119: {
    name: "ClearTotalTime",
    type: "number",
    provenance: "mega",
  },
  120: {
    name: "ClearTotalArea",
    type: "number",
    provenance: "mega",
  },
  127: {
    name: "water_tank_status",
    type: "bool",
    provenance: "mega",
  },
  129: {
    name: "mop_status",
    type: "bool",
    provenance: "mega",
  },
  134: {
    name: "rssi",
    type: "number",
    provenance: "mega",
  },
};

/**
 * eufy Smart Display (T87Ax) param space — ids 8001-8006.
 *
 * Its own table rather than a corner of {@link SECURITY_PARAMS}: nothing in the 8000s carries a security
 * meaning, so reading these ids there would decode a future security param assigned in this range as
 * whatever it means on a camera.
 *
 * Every id here was reported by a live T87A0 (captured 2026-09-04). That the device SENT an id is what
 * earns it a place in this table; the provenance label beside each one rates something narrower — how far
 * its NAME is trusted. `modelName` and `modelCode` are `mega`, their values matching what the cloud
 * record already carried. `battery` is `verified`: the id is real and the reading consistent, but the
 * name came from the maintainer's own knowledge of the hardware rather than from the cloud data-point
 * list, and `"100"` fits brightness, volume or charge equally.
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
    provenance: "verified",
  },
  8003: {
    name: "softwareVersion",
    type: "string",
    provenance: "guessed",
  },
  8005: {
    name: "modelName",
    type: "string",
    provenance: "mega",
  },
  8006: {
    name: "modelCode",
    type: "string",
    provenance: "mega",
  },
};
