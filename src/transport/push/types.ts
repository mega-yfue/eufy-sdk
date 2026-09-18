/**
 * eufy FCM push payload types.
 *
 * A push arrives as an MCS DataMessageStanza whose `app_data` has a `payload`
 * entry = base64( NUL-terminated JSON ). That JSON is the EufyPushMessage; its
 * nested `payload` is device-type specific. The v6 app enriches these with AI
 * detection fields (person/vehicle/pet/package/faces/crops/short video) — see
 * PushEnrichment.
 */

/**
 * Raw MCS frame: a tag + the decoded protobuf object.
 *
 * A framed message off the push socket — internal wire shape.
 * @internal
 */
export interface McsMessage {
  tag: number;
  object: any;
}

/**
 * Outer FCM message after app_data extraction.
 *
 * The undecoded push envelope, surfaced on the facade's diagnostic event only.
 * @internal
 */
export interface RawPushMessage {
  id?: string;
  from?: string;
  to?: string;
  category?: string;
  persistentId?: string;
  ttl?: number;
  sent?: string;
  /** The eufy envelope: every app_data entry, with the `payload` entry JSON-parsed in place. */
  payload: EufyPushMessage;
}

/** The eufy JSON envelope inside the push. */
export interface EufyPushMessage {
  type?: string | number;
  title?: string;
  content?: string;
  device_sn?: string;
  station_sn?: string;
  event_time?: string;
  push_time?: string;
  doorbell?: string;
  "google.c.sender.id"?: string;
  /** Device-type specific body (often a JSON string that we further parse). */
  payload?: PushPayload;
  [k: string]: unknown;
}

/** v6 AI/media enrichment fields (optional; present on newer cameras/doorbells). */
export interface PushEnrichment {
  /** Comma list of detection types, e.g. "0,1,2,3" (person/vehicle/pet/package). */
  ai_detect_type?: string;
  /** Detected object class names. */
  objects?: string[] | { names?: string[] };
  person?: string | number;
  person_id?: number;
  person_count?: number;
  ai_faces?: Array<{ face_id?: number; confidence?: number; x?: number; y?: number; width?: number; height?: number }>;
  face_id?: number;
  face_ids?: number[];
  familiar_faces?: unknown[];
  vehicle_types?: string[];
  pet_type?: string | number;
  /** Sound/cry detection (indoor). */
  crying?: number | boolean;
  sound_detection?: number | boolean;
  sound_type?: string | number;
  /** Media enrichment. */
  thumbnail?: string;
  short_video_url?: string;
  video_url?: string;
  cover_path?: string;
  crop_local_path?: string;
  crop_url?: string;
  /** Timing. */
  trigger_time?: number;
  duration?: number;
  event_end_time?: number;
}

/**
 * Normalised device push payload. Superset of the common fields across device
 * types plus the v6 enrichment; concrete pushes populate a subset. The short
 * single-letter keys are eufy's wire names (kept for fidelity).
 */
export interface PushPayload extends PushEnrichment {
  // identity
  device_sn?: string;
  station_sn?: string;
  s?: string; // station sn (short)
  name?: string;
  device_name?: string;
  nick_name?: string;
  n?: string; // nickname (short)
  channel?: number;
  c?: number; // channel (short)

  // event classification
  a?: number; // CusPushEvent
  event_type?: number;
  msg_type?: number;
  type?: number;
  alarm_type?: number; // CusPushAlarmType
  mode?: number;
  arming?: number;
  notification_style?: number; // NotificationStyle

  // sensor / contact
  e?: string; // sensor open state ("1"/"0")
  /** Unverified vendor field; polarity and entity scope are not established. */
  m?: number;

  // media (the thumbnail lives here)
  pic_url?: string;
  file_path?: string;
  p?: string; // file path (short)
  storage_type?: number;
  cipher?: number;
  k?: number; // cipher (short)

  // timing / ids
  create_time?: number;
  event_time?: number;
  trigger_time?: number;
  session_id?: string;
  unique_id?: string;
  push_count?: number;

  // user
  user_id?: string;
  user_name?: string;
  short_user_id?: string;

  [k: string]: unknown;
}

/** Facts available to attribute a push-provided thumbnail candidate. */
export type ThumbnailCandidateAttribution =
  { kind: "device"; deviceSn: string } | { kind: "station"; stationSn?: string } | { kind: "ambiguous" };

/** A push-provided thumbnail URL together with its transport-level attribution facts. */
export interface ThumbnailCandidate {
  url: string;
  attribution: ThumbnailCandidateAttribution;
}

/** A normalised, consumer-facing push event emitted by the client. */
export interface PushEvent {
  /** Best-effort device serial (falls back to station). */
  deviceSn?: string;
  stationSn?: string;
  /** Numeric event type as the cloud sends it; `eventName` carries the resolved label. */
  eventType?: number;
  /** Resolved event name where known. */
  eventName?: string;
  /** The thumbnail URL, if the push carried one (pic_url/thumbnail). */
  thumbnailUrl?: string;
  /** A usable thumbnail URL and the identity claims carried beside it. */
  thumbnailCandidate?: ThumbnailCandidate;
  /** Cipher id for decoding the media (when present). */
  cipher?: number;
  /** The full parsed eufy payload. */
  payload: PushPayload;
  /** The whole raw push (envelope + app_data). */
  raw: RawPushMessage;
}

/** Persisted FCM credentials so we register once and reconnect across runs. */
export interface FcmCredentials {
  fid: string;
  androidId: string;
  securityToken: string;
  /** The FCM registration token (what we hand to eufy's cloud). */
  fcmToken: string;
  /** Firebase installation refresh token (for auth-token renewal). */
  refreshToken?: string;
  createdAt: number;
}
