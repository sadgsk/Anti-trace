import type { Context, Model, StreamFn, StreamOptions } from "../../src/types.ts";
import { createFakeStreamFn, type FakeStreamTurn } from "./fake-stream.ts";

export type ModelRequest = { model: Model; context: Context; options?: StreamOptions };
export type ResponseStep = FakeStreamTurn | ((request: ModelRequest) => FakeStreamTurn | Promise<FakeStreamTurn>);

/** Script model behavior while exercising the real Agent, tools and session code. */
export function createScriptedModel(steps: readonly ResponseStep[] = []) {
	const queue = [...steps];
	const requests: ModelRequest[] = [];
	const streamFn: StreamFn = async (model, context, options) => {
		const request: ModelRequest = {
			model: structuredClone(model),
			context: {
				...context,
				messages: structuredClone(context.messages),
				tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
			},
			options,
		};
		requests.push(request);
		const step = queue.shift();
		if (step === undefined) throw new Error("Unexpected model request: scripted responses exhausted");
		const turn = typeof step === "function" ? await step(request) : step;
		return createFakeStreamFn([turn])(model, context, options);
	};
	return {
		streamFn, requests,
		appendResponses: (...responses: ResponseStep[]) => queue.push(...responses),
		get pendingResponses() { return queue.length; },
	};
}
