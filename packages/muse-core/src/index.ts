export const MUSE_VERSION = "0.1.1";

export {
  deleteKeychainSession,
  KEYCHAIN_SERVICE,
  readKeychainSession,
  saveKeychainSession,
} from "./auth/keychain-session-store.js";
export { loginWithOtp, type OtpLoginOptions } from "./auth/native-auth.js";
export {
  type ConfirmOutcome,
  NativeAuthClient,
  type NativeAuthClientOptions,
  type TwoFactorMethod,
} from "./auth/native-auth-client.js";
export {
  type AskOptions,
  type AskResult,
  ask,
  cancel,
  history,
} from "./chat.js";
export {
  type ConnectedMuse,
  type ConnectMuseOptions,
  connectMuse,
} from "./client.js";
export {
  buildNoiseWsUrl,
  DEFAULT_APP_ID,
  extractVmId,
  MUSE_ORIGIN,
  NOISE_SHARED_INGRESS_HOST,
  NOISE_WS_PATH,
} from "./config.js";
export {
  type CookieSourceOptions,
  listChromeProfilesWithMuse,
  resolveCookie,
} from "./cookie-source.js";
export {
  GatewayRequestError,
  MuseError,
  type MuseErrorKind,
} from "./errors.js";
export {
  type BinaryResult,
  type ConnectOptions,
  type DuplexStream,
  type GatewayEvent,
  MuseGateway,
} from "./gateway.js";
export {
  downloadVmFile,
  type LibraryEntry,
  listLibrary,
  type MediaRef,
  mediaFromEvents,
  mediaFromPresentation,
  toVmPath,
} from "./media.js";
export {
  appendQuery,
  findRoute,
  type HttpVerb,
  type MethodSafety,
  type NoiseService,
  RPC_ROUTES,
  type RpcRouteSpec,
  resolveRoutePath,
} from "./rpc-catalog.js";
export {
  MuseSession,
  type MuseSessionOptions,
  type SessionVm,
  type VmCredentials,
} from "./session.js";
export {
  type TurnTool,
  TurnTracker,
  type TurnUpdate,
  transcriptText,
} from "./turn-tracker.js";
export {
  presentBrowserTask,
  startVncBridge,
  type VncBridge,
  type VncBridgeOptions,
} from "./vnc-bridge.js";
