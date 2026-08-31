import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { AiChatMessage, AiModelConfig } from "@gadgets/workshop-shared/api";
import type { CodeChange } from "@gadgets/workshop-shared/code-change";
import { runAgent, type AgentHooks } from "../src/agent";
import type { ModelHandle } from "../src/ai-models";

// LOCAL PATCH: fail-soft replay of stored changes + bounded replay diff — remove when fixed upstream
//
// Regression coverage for the replay poison pill: a stored "changes" message whose recorded
// change does not fit the content agent replay reconstructs used to throw straight out of
// runAgent(). Because replay is redone from scratch on every turn, the same throw recurred
// forever and the chat became permanently unusable. Replay must degrade instead.

const AUTHOR = {type: "user", id: "user-1", name: "Tester"} as const;

function message(sequence: number, body: Record<string, unknown>): AiChatMessage {
  return {
    chatId: 7,
    sequence,
    timestamp: new Date(1_700_000_000_000 + sequence * 1000),
    author: AUTHOR,
    ...body,
  } as unknown as AiChatMessage;
}

/**
 * A `ModelHandle` whose stream immediately returns a text-only assistant message with stop
 * reason "stop", so a turn completes without any provider. Records every context it was handed,
 * which is how the tests inspect what replay produced.
 */
function makeModelHandle() {
  let contexts: Context[] = [];
  let model = {
    id: "test-model",
    api: "anthropic-messages",
    provider: "anthropic",
    name: "Test Model",
    reasoning: false,
    input: ["text"],
    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
    contextWindow: 200000,
    maxTokens: 8192,
  } as unknown as Model<Api>;

  let handle: ModelHandle = {
    model,
    stream: (_model, context) => {
      contexts.push(context);
      let msg = {
        role: "assistant",
        content: [{type: "text", text: "ok"}],
        api: model.api,
        provider: "anthropic",
        model: "test-model",
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
        },
        stopReason: "stop",
        timestamp: Date.now(),
      } as unknown as AssistantMessage;
      let stream = createAssistantMessageEventStream();
      stream.push({type: "start", partial: msg});
      stream.push({type: "text_start", contentIndex: 0, partial: msg});
      stream.push({type: "text_delta", contentIndex: 0, delta: "ok", partial: msg});
      stream.push({type: "text_end", contentIndex: 0, content: "ok", partial: msg});
      stream.push({type: "done", reason: "stop", message: msg});
      stream.end(msg);
      return stream;
    },
  };
  return {handle, contexts};
}

/** Every model-visible text replay handed to the model, flattened. */
function modelTexts(contexts: Context[]): string[] {
  let out: string[] = [];
  for (let context of contexts) {
    for (let msg of context.messages as unknown as {content?: unknown}[]) {
      let content = msg.content;
      if (typeof content === "string") {
        out.push(content);
      } else if (Array.isArray(content)) {
        for (let part of content as {type?: string, text?: string}[]) {
          if (part.type === "text" && typeof part.text === "string") out.push(part.text);
        }
      }
    }
  }
  return out;
}

function makeHooks(): AgentHooks {
  return {
    getChatAgentContext: () => ({chatId: 7, bindings: {}}),
    getChatCodeBase: () => undefined,
    appendAgentCodeChange: async () => ({generation: 1, revision: 1}),
    flushAgentChanges: () => false,
    listUnmaterializedChatChanges: () => [],
    undeclaredChatPins: () => [],
    getGadgetHead: () => undefined,
    readCommitFiles: async () => new Map(),
    changedPaths: async () => new Set(),
    listGadgetInfo: () => [{id: 1, title: "Doc", isDefault: false, bindings: []}],
    resolveWorkpieceRoot: () => ({workpieceId: 1}),
    createGadget: () => ({gadgetId: 1}),
    describeBinding: async () => "",
    addGadgetBinding: () => {},
    prepareChatBindings: async () =>
        [{name: "DOC", target: 1, title: "Doc", isGadget: true}],
    executeCodeMode: async () => "",
    activeAgentCallbackCount: () => 0,
    rejectAllAgentCallbacks: () => {},
    consumeCapturedActions: () => undefined,
    addChatMessages: () => 0,
    emitChatStreamEvent: () => {},
    getChatModelData: () => undefined,
    getChatAttachmentData: async () => new Uint8Array(),
    getWebFetchEnv: () => ({}),
    getInstanceInstructions: async () => "",
    listConnectableVendors: async () => [],
    listConnectableResources: async () => "",
    requestConnection: async () => ({}),
    consumeCapturedConnectionRequests: () => [],
    listAvailableBlueprints: async () => "",
    describeStandardFormats: async () => "",
    fetchBlueprint: async () => ({files: {}, notes: ""}),
    recordAgentObservation: async () => {},
  } as unknown as AgentHooks;
}

const MODEL_CONFIG = {
  id: "test-model",
  name: "Test Model",
  provider: "anthropic",
} as unknown as AiModelConfig;

const DEGRADED_NOTE = "the recorded change could not be replayed";

async function replay(chatMessages: AiChatMessage[]) {
  let {handle, contexts} = makeModelHandle();
  let controller = new AbortController();
  await runAgent(
      makeHooks(), handle, 7, AUTHOR, chatMessages, controller.signal, AUTHOR, false,
      {modelConfig: MODEL_CONFIG, measuredTokens: 0});
  return {texts: modelTexts(contexts), contexts};
}

function changesMessage(sequence: number, change: CodeChange, revision: number): AiChatMessage {
  return message(sequence, {
    type: "changes",
    change,
    watermark: {changesGeneration: 1, throughRevision: revision},
  });
}

describe("agent replay of a poisoned \"changes\" message", () => {
  it("does not throw when a user change edits a file replay holds no content for", async () => {
    // `applyCodeChange` throws "edit of absent file" here. Before the fail-soft guard this threw
    // out of runAgent() on every turn, forever.
    let change: CodeChange = {1: [["doc.md", {edit: [[5, "replacement"]]}]]};

    let {texts} = await replay([
      message(1, {type: "message", message: "edit my doc"}),
      changesMessage(2, change, 1),
    ]);

    // The turn ran (the model was called) and the model was told its file view is stale.
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some(t => t.includes(DEGRADED_NOTE))).toBe(true);
  });

  it("does not throw when a user change's before-length does not match the content", async () => {
    // The file exists at length 11, but the change tiles a text of length 4: CodeMirror's
    // ChangeSet.apply throws on the length mismatch.
    let {texts} = await replay([
      message(1, {type: "message", message: "edit my doc"}),
      changesMessage(2, {1: [["doc.md", {set: "alpha\nbeta\n"}]]}, 1),
      changesMessage(3, {1: [["doc.md", {edit: [[4, "gamma"]]}]]}, 2),
      message(4, {type: "message", message: "what changed?"}),
    ]);

    expect(texts.some(t => t.includes(DEGRADED_NOTE))).toBe(true);
  });

  it("still surfaces a real diff when the change applies cleanly", async () => {
    let {texts} = await replay([
      message(1, {type: "message", message: "hi"}),
      changesMessage(2, {1: [["doc.md", {set: "alpha\nbeta\n"}]]}, 1),
      changesMessage(3, {1: [["doc.md", {set: "alpha\ngamma\n"}]]}, 2),
    ]);

    expect(texts.some(t => t.includes("+++ b/doc.md"))).toBe(true);
    expect(texts.some(t => t.includes("-beta"))).toBe(true);
    expect(texts.every(t => !t.includes(DEGRADED_NOTE))).toBe(true);
  });
});

describe("replayed diff size guard", () => {
  it("omits the diff and summarizes instead when the file is too large to diff", async () => {
    // Two wholly dissimilar ~120KB texts: their combined length exceeds
    // MAX_REPLAY_DIFF_INPUT_LENGTH, so the Myers diff is skipped outright.
    let before = Array.from({length: 12000}, (_, i) => `old line ${i}`).join("\n");
    let after = Array.from({length: 12000}, (_, i) => `new line ${i * 7}`).join("\n");
    expect(before.length + after.length).toBeGreaterThan(128 * 1024);

    let {texts} = await replay([
      message(1, {type: "message", message: "hi"}),
      changesMessage(2, {1: [["doc.md", {set: before}]]}, 1),
      changesMessage(3, {1: [["doc.md", {set: after}]]}, 2),
    ]);

    let summary = texts.find(t => t.includes("diff omitted"));
    expect(summary).toBeDefined();
    expect(summary).toContain("bytes changed");
    // The whole ~240KB of file content must not be inlined as a diff.
    expect(texts.every(t => t.length < 64 * 1024)).toBe(true);
  });
});
