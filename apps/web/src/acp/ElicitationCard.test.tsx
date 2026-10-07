import { scoped } from "../sources/scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AcpElicitationForm } from "@armadra/shared";

const api = vi.hoisted(() => ({ answerElicitation: vi.fn() }));
vi.mock("./api", () => ({ acpApi: api }));

import { useAgentStatusStore } from "@/agent/status-store";
import {
  ElicitationCard,
  contentOf,
  initialValues,
  safeUrl,
} from "./ElicitationCard";
import { useAcpStore, type AcpElicitationView } from "./store";

const form: AcpElicitationForm = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name" },
    color: {
      type: "string",
      title: "Color",
      enum: ["red", "blue"],
      enumNames: ["Red", "Blue"],
      default: "red",
    },
    count: { type: "integer", title: "Count", minimum: 1 },
    loud: { type: "boolean", title: "Loud" },
  },
  required: ["name"],
};

const view: AcpElicitationView = {
  pendingId: "n1-1-acp-e1",
  elicitation: { message: "Fill it in", mode: "form", requestedSchema: form },
};

beforeEach(() => {
  api.answerElicitation.mockReset().mockResolvedValue({});
  useAcpStore.getState().reset();
  useAcpStore.getState().addElicitation("n1", view);
});

afterEach(cleanup);

describe("contentOf", () => {
  it("drops empty optional strings, converts numbers, keeps booleans", () => {
    const values = { ...initialValues(form), name: "ada", count: "3" };
    expect(contentOf(form, values)).toEqual({
      name: "ada",
      color: "red",
      count: 3,
      loud: false,
    });
    expect(contentOf(form, { ...values, count: "" })).toEqual({
      name: "ada",
      color: "red",
      loud: false,
    });
  });

  it("rejects a missing required field and broken constraints", () => {
    const values = initialValues(form);
    expect(contentOf(form, values)).toBeNull();
    expect(contentOf(form, { ...values, name: "a", count: "0" })).toBeNull();
    expect(contentOf(form, { ...values, name: "a", count: "1.5" })).toBeNull();
    expect(
      contentOf(form, { ...values, name: "a", color: "green" }),
    ).toBeNull();
  });
});

describe("safeUrl", () => {
  it("only lets http(s) through", () => {
    expect(safeUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
});

describe("ElicitationCard", () => {
  it("draws text, enum, number and boolean fields from the schema", () => {
    render(<ElicitationCard nodeId="n1" view={view} canAnswer />);
    expect(screen.getByText("Fill it in")).toBeTruthy();
    expect(screen.getByLabelText(/Name/).tagName).toBe("INPUT");
    expect(screen.getByRole("combobox").textContent).toContain("Red");
    expect((screen.getByLabelText(/Count/) as HTMLInputElement).type).toBe(
      "number",
    );
    expect(screen.getByRole("switch")).toBeTruthy();
  });

  it("keeps submit disabled until the form is valid, then accepts once", async () => {
    const resolveApproval = vi.spyOn(
      useAgentStatusStore.getState(),
      "resolveApproval",
    );
    render(<ElicitationCard nodeId="n1" view={view} canAnswer />);
    const submit = screen.getByRole("button", {
      name: "提交",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "ada" },
    });
    fireEvent.click(screen.getByRole("switch"));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.answerElicitation).toHaveBeenCalledWith("n1-1-acp-e1", {
        action: "accept",
        content: { name: "ada", color: "red", loud: true },
      }),
    );
    expect(api.answerElicitation).toHaveBeenCalledTimes(1);
    expect(useAcpStore.getState().elicitations[scoped("n1")]).toBeUndefined();
    expect(resolveApproval).toHaveBeenCalledWith("n1-1-acp-e1");
  });

  it("declines and cancels without content", async () => {
    render(<ElicitationCard nodeId="n1" view={view} canAnswer />);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() =>
      expect(api.answerElicitation).toHaveBeenCalledWith("n1-1-acp-e1", {
        action: "cancel",
      }),
    );
    cleanup();
    render(<ElicitationCard nodeId="n1" view={view} canAnswer />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(api.answerElicitation).toHaveBeenLastCalledWith("n1-1-acp-e1", {
        action: "decline",
      }),
    );
  });

  it("puts the card back when the answer is not taken", async () => {
    api.answerElicitation.mockRejectedValue(new Error("400"));
    render(<ElicitationCard nodeId="n1" view={view} canAnswer />);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() =>
      expect(useAcpStore.getState().elicitations[scoped("n1")]).toEqual([view]),
    );
  });

  it("offers only decline and cancel when the form could not be kept", () => {
    render(
      <ElicitationCard
        nodeId="n1"
        view={{
          pendingId: "e2",
          elicitation: { message: "Nested", mode: "form" },
        }}
        canAnswer
      />,
    );
    expect(screen.queryByRole("button", { name: "提交" })).toBeNull();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("url mode shows a safe link and continues without content", async () => {
    render(
      <ElicitationCard
        nodeId="n1"
        view={{
          pendingId: "e3",
          elicitation: {
            message: "Authorize",
            mode: "url",
            url: "https://example.com/auth",
          },
        }}
        canAnswer
      />,
    );
    const link = screen.getByRole("link") as HTMLAnchorElement;
    expect(link.href).toBe("https://example.com/auth");
    expect(link.rel).toContain("noopener");
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() =>
      expect(api.answerElicitation).toHaveBeenCalledWith("e3", {
        action: "accept",
      }),
    );
  });

  it("shows only the message to someone who cannot answer", () => {
    render(<ElicitationCard nodeId="n1" view={view} canAnswer={false} />);
    expect(screen.getByText("Fill it in")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("等待接管")).toBeTruthy();
  });
});
