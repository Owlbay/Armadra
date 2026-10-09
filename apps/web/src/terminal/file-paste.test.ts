import { describe, expect, it, vi } from "vitest";
import {
  MAX_AGENT_UPLOAD_BYTES,
  terminalSessionSchema,
  type TerminalSession,
} from "@armadra/shared";

import {
  agentPathText,
  filesOf,
  pasteFilesIntoTerminal,
  type TerminalFileTarget,
} from "./file-paste";

const WORKSPACE = "019ff7d1-0d12-7421-833d-2c5e8d64ed10";
const SESSION = "019ff7d1-0d12-7421-833d-2c5e8d64ed11";
const UPLOADS = "/Users/me/Library/Application Support/Armadra/agent-uploads";

function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return terminalSessionSchema.parse({
    id: SESSION,
    workspaceId: WORKSPACE,
    cwd: "/repo",
    shell: "/bin/zsh",
    command: null,
    agentId: "claude",
    status: "running",
    exitCode: null,
    pid: 1200,
    createdAt: "2026-09-05T00:00:00.000Z",
    endedAt: null,
    sessionKey: SESSION,
    backend: "tmux",
    attachState: "live",
    generation: 3,
    ...overrides,
  });
}

const target: TerminalFileTarget = {
  workspaceId: WORKSPACE,
  sessionId: SESSION,
  generation: 3,
  ssh: false,
  agentId: "claude",
};

function png(name = "image.png", size = 4): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

function services(value = session()) {
  let n = 0;
  return {
    getTerminal: vi.fn(async () => value),
    upload: vi.fn(async (file: File) => {
      n += 1;
      return { path: `${UPLOADS}/${WORKSPACE}/${n}/${file.name}` };
    }),
  };
}

describe("agentPathText", () => {
  it("leaves a plain path bare and quotes one with spaces", () => {
    expect(agentPathText("/tmp/a/shot.png")).toBe("/tmp/a/shot.png");
    expect(agentPathText(`${UPLOADS}/x.png`)).toBe(`"${UPLOADS}/x.png"`);
    expect(agentPathText('/tmp/say "hi".png')).toBe(`'/tmp/say "hi".png'`);
  });

  it("turns a Windows path into forward slashes", () => {
    expect(agentPathText("C:\\Users\\a\\x.png")).toBe("C:/Users/a/x.png");
  });

  it("refuses control characters", () => {
    expect(() => agentPathText("/tmp/a\nb.png")).toThrow();
  });
});

describe("filesOf", () => {
  it("reads files and falls back to file items", () => {
    const file = png();
    expect(
      filesOf({ files: [file], items: [] } as unknown as DataTransfer),
    ).toEqual([file]);
    expect(
      filesOf({
        files: [],
        items: [
          { kind: "string", getAsFile: () => null },
          { kind: "file", getAsFile: () => file },
        ],
      } as unknown as DataTransfer),
    ).toEqual([file]);
    expect(filesOf(null)).toEqual([]);
  });
});

describe("pasteFilesIntoTerminal (§56)", () => {
  it("uploads each file and pastes its path once, without Enter", async () => {
    const api = services();
    const paste = vi.fn();
    await pasteFilesIntoTerminal(
      [png("a.png"), png("b.png")],
      target,
      api,
      () => true,
      paste,
    );
    expect(api.upload).toHaveBeenCalledTimes(2);
    expect(paste.mock.calls.map(([text]) => text)).toEqual([
      `"${UPLOADS}/${WORKSPACE}/1/a.png"`,
      " ",
      `"${UPLOADS}/${WORKSPACE}/2/b.png"`,
    ]);
    for (const [text] of paste.mock.calls) expect(text).not.toMatch(/[\r\n]/);
  });

  it("quotes for the shell when the session is not an agent", async () => {
    const api = services(session({ agentId: null }));
    const paste = vi.fn();
    await pasteFilesIntoTerminal(
      [png("a.png")],
      { ...target, agentId: undefined },
      api,
      () => true,
      paste,
    );
    expect(paste).toHaveBeenCalledWith(`'${UPLOADS}/${WORKSPACE}/1/a.png' `);
  });

  it("uses the file's own path on this machine instead of uploading", async () => {
    const api = services();
    const paste = vi.fn();
    await pasteFilesIntoTerminal(
      [png("big.png", 8)],
      target,
      { ...api, localPath: () => "/Users/me/Desktop/big.png" },
      () => true,
      paste,
    );
    expect(api.upload).not.toHaveBeenCalled();
    expect(paste).toHaveBeenCalledWith("/Users/me/Desktop/big.png");
  });

  it("refuses SSH nodes, pending launches and open prompts before uploading", async () => {
    for (const [extra, key] of [
      [{ ssh: true }, "fileDrag.executionUnsupported"],
      [{ automaticInputPending: true }, "fileDrag.launchPending"],
      [{ awaitingAnswer: true }, "fileDrag.awaitingAnswer"],
    ] as const) {
      const api = services();
      const paste = vi.fn();
      await expect(
        pasteFilesIntoTerminal(
          [png()],
          { ...target, ...extra },
          api,
          () => true,
          paste,
        ),
      ).rejects.toMatchObject({ messageKey: key });
      expect(api.upload).not.toHaveBeenCalled();
      expect(paste).not.toHaveBeenCalled();
    }
  });

  it("refuses a file over the limit and a session that moved on", async () => {
    const api = services();
    const big = { name: "big.bin", size: MAX_AGENT_UPLOAD_BYTES + 1 } as File;
    await expect(
      pasteFilesIntoTerminal([big], target, api, () => true, vi.fn()),
    ).rejects.toMatchObject({ messageKey: "fileDrag.tooLarge" });
    const moved = services(session({ generation: 4 }));
    await expect(
      pasteFilesIntoTerminal([png()], target, moved, () => true, vi.fn()),
    ).rejects.toMatchObject({ messageKey: "fileDrag.destinationChanged" });
    expect(moved.upload).not.toHaveBeenCalled();
  });

  it("does not paste when the terminal changed during the upload", async () => {
    const api = services();
    const paste = vi.fn();
    let active = true;
    api.upload.mockImplementation(async (file: File) => {
      active = false;
      return { path: `/tmp/${file.name}` };
    });
    await expect(
      pasteFilesIntoTerminal([png()], target, api, () => active, paste),
    ).rejects.toMatchObject({ messageKey: "fileDrag.destinationChanged" });
    expect(paste).not.toHaveBeenCalled();
  });
});
