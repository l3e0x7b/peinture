import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The upscaler Space (Upsampler/media-upscaler) answers /upscale_image with a
 * PAIR [original, upscaled] so its own UI can show a before/after slider.
 * These tests pin the client-side contract: we must return the UPSCALED file,
 * never the untouched input, and must tolerate the shapes Gradio can emit.
 */

const BASE = "https://upsampler-media-upscaler.hf.space";

const inputFile = {
  path: "/tmp/gradio/a/image.webp",
  url: `${BASE}/gradio_api/file=/tmp/gradio/a/image.webp`,
  orig_name: "image.webp",
};
const upscaledFile = {
  path: "/tmp/gradio/b/upscaled.webp",
  url: `${BASE}/gradio_api/file=/tmp/gradio/b/upscaled.webp`,
  orig_name: "upscaled.webp",
};

const sseResponse = (payload: unknown) =>
  new Response(`event: complete\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Stub fetch for one upscale call:
 * upload -> named join -> SSE result.
 */
const stubFetch = (ssePayload: unknown) => {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith("/gradio_api/upload")) {
      return jsonResponse(["/tmp/gradio/uploaded/input.webp"]);
    }
    if (href.includes("/gradio_api/call/upscale_image") && init?.method === "POST") {
      return jsonResponse({ event_id: "evt-1" });
    }
    if (href.includes("/gradio_api/call/upscale_image/evt-1")) {
      return sseResponse(ssePayload);
    }
    if (href.startsWith(BASE)) {
      // image download / anything else the helper touches
      return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  });
  return { fetchMock, calls };
};

describe("upscaler (Upsampler/media-upscaler integration)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const runUpscaler = async (
    ssePayload: unknown,
    model?: string,
  ): Promise<{ url: string; calls: string[]; body: any }> => {
    const { fetchMock, calls } = stubFetch(ssePayload);
    // fetchBlob / uploadToGradio go through global fetch too
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    });

    const { upscaler } = await import("../services/hfService");
    const result = await upscaler("blob:source-image", model);
    const joinCall = fetchMock.mock.calls.find(
      ([u, i]: [any, any]) =>
        String(u).includes("/call/upscale_image") && i?.method === "POST",
    );
    return {
      url: result.url,
      calls,
      body: joinCall ? JSON.parse(String(joinCall[1].body)) : null,
    };
  };

  it("returns the upscaled file, not the echoed input (real pair shape)", async () => {
    const { url, body } = await runUpscaler([[inputFile, upscaledFile]]);
    expect(url).toBe(upscaledFile.url);
    // positional order must match the endpoint signature
    expect(body.data[1]).toBe("4xRealESRGAN");
    expect(body.data[2]).toBe(false);
  });

  it("tolerates a flat [input, upscaled] payload", async () => {
    const { url } = await runUpscaler([inputFile, upscaledFile]);
    expect(url).toBe(upscaledFile.url);
  });

  it("picks by name even if the pair order is reversed", async () => {
    const { url } = await runUpscaler([[upscaledFile, inputFile]]);
    expect(url).toBe(upscaledFile.url);
  });

  it("rebuilds the URL when the Space returns path-only FileData", async () => {
    const pathOnly = { path: "/tmp/gradio/c/upscaled.png", orig_name: "upscaled.png" };
    const { url } = await runUpscaler([[inputFile, pathOnly]]);
    expect(url).toBe(`${BASE}/gradio_api/file=${pathOnly.path}`);
  });

  it("passes the configured model through", async () => {
    const { body } = await runUpscaler([[inputFile, upscaledFile]], "4xSwinIRLarge");
    expect(body.data[1]).toBe("4xSwinIRLarge");
  });

  it("falls back to a supported model for stale persisted configs", async () => {
    // configs saved before the Space swap still say RealESRGAN_x4plus
    const { body } = await runUpscaler([[inputFile, upscaledFile]], "RealESRGAN_x4plus");
    expect(body.data[1]).toBe("4xRealESRGAN");
  });

  it("surfaces error_upscale_failed when the Space returns no usable file", async () => {
    await expect(runUpscaler([inputFile])).rejects.toThrow("error_upscale_failed");
  });
});
