/** apiary/agent — agent orchestration framework. */

export { type RoomResolver, type RoomConnection, type ContentPart, type ProcessorBridge, type ToolHandlerOptions } from "./types.js";
export { type RoomDataSource, LocalRoomDataSource } from "./room-data-source.js";
export { formatEvent, participantLabel, messageRef, contentPartsToString } from "./prompts.js";
export { EventProcessor, type EventProcessorOptions } from "./event-processor.js";
export { EventMultiplexer, type LabeledEvent } from "./multiplexer.js";
export { type EngagementMode, type EventDisposition, type EngagementStrategy, StoopsEngagement, classifyEvent } from "./engagement.js";
export { createRuntimeMcpServer, type RuntimeMcpServer, type RuntimeMcpServerOptions } from "./mcp/index.js";
export { RefMap } from "./ref-map.js";
export { RemoteRoomDataSource } from "./remote-room-data-source.js";
export { SseMultiplexer } from "./sse-multiplexer.js";
