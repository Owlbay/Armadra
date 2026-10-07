import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  act,
} from "@testing-library/react";
import type { BoardComment, CommentPerson } from "@armadra/shared";

import { TestProviders, installDomPolyfills } from "@/app/test-harness";
import { terminal } from "../realtime.fixture";
import { CommentComposer, mentionQuery } from "./CommentComposer";
import {
  anchorAt,
  anchorPosition,
  clusterPins,
  pinGroups,
} from "./CommentLayer";
import { CommentPin } from "./CommentPin";
import {
  CommentBody,
  CommentThread,
  commentUrl,
  markdownSource,
} from "./CommentThread";
import { CommentsPanelView } from "./CommentsPanel";
import { bodyParts, decodeMentions, encodeMentions, threadsOf } from "./store";

/** 评论（契约 §16.3，设计系统 §5.7）。 */

const ME = "a".repeat(32);
const VERA = "c".repeat(32);
const PEOPLE: CommentPerson[] = [
  { principalId: ME, name: "Me" },
  { principalId: VERA, name: "Vera" },
];

function comment(patch: Partial<BoardComment> = {}): BoardComment {
  return {
    id: "c1",
    boardId: "b1",
    anchor: { kind: "point", x: 10, y: 20 },
    body: "hello",
    authorPrincipalId: ME,
    parentId: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    resolvedAtMs: null,
    mentions: [],
    ...patch,
  };
}

beforeAll(() => installDomPolyfills());
afterEach(() => cleanup());

describe("提及记号", () => {
  it("选过的人发出前换成记号，编辑时还原；正文拆成文本与提及", () => {
    const body = encodeMentions("请 @Vera 看，@Bob 不是成员", [PEOPLE[1]!]);
    expect(body).toBe(`请 @[Vera](principal:${VERA}) 看，@Bob 不是成员`);
    expect(decodeMentions(body)).toEqual({
      text: "请 @Vera 看，@Bob 不是成员",
      picked: [PEOPLE[1]],
    });
    expect(bodyParts(body)).toEqual([
      { kind: "text", text: "请 " },
      { kind: "mention", name: "Vera", id: VERA },
      { kind: "text", text: " 看，@Bob 不是成员" },
    ]);
  });

  it("长名字先换，不被短名字截断", () => {
    const ann = { principalId: "1".repeat(32), name: "Ann" };
    const anna = { principalId: "2".repeat(32), name: "Anna" };
    expect(encodeMentions("@Anna", [ann, anna])).toBe(
      `@[Anna](principal:${anna.principalId})`,
    );
  });

  it("光标前未打完的 @ 才算查询", () => {
    expect(mentionQuery("hi @Ve", 6)).toEqual({ start: 3, query: "Ve" });
    expect(mentionQuery("a@b", 3)).toBeNull();
    expect(mentionQuery("@Vera done", 10)).toBeNull();
  });
});

describe("线程与钉", () => {
  it("回复挂在父评论下，同一锚点聚成一枚钉，计数含回复", () => {
    const root = comment({ id: "r", anchor: { kind: "node", id: "n1" } });
    const reply = comment({ id: "x", parentId: "r", anchor: root.anchor });
    const other = comment({
      id: "o",
      anchor: { kind: "node", id: "n1" },
      resolvedAtMs: 5,
    });
    expect(
      threadsOf([root, reply, other]).map((t) => t.replies.length),
    ).toEqual([1, 0]);
    const [pin] = pinGroups([root, reply, other]);
    expect(pin).toMatchObject({ key: "node:n1", count: 3, open: true });
    expect(pinGroups([other])[0]?.open).toBe(false);
  });

  it("锚点坐标：节点右上角、白板对象右上角、点本身；不在了是 null", () => {
    const node = terminal("n1", 100);
    const nodes = [node];
    const items = [
      { id: "wb:1", x: 5, y: 6, w: 10, h: 20 },
    ] as unknown as Parameters<typeof anchorPosition>[2];
    const box = { x: node.position.x, y: node.position.y };
    expect(anchorPosition({ kind: "node", id: "n1" }, nodes, items)).toEqual({
      x: box.x + (node.size?.width ?? 0),
      y: box.y,
    });
    expect(anchorPosition({ kind: "item", id: "wb:1" }, nodes, items)).toEqual({
      x: 15,
      y: 6,
    });
    expect(
      anchorPosition({ kind: "node", id: "gone" }, nodes, items),
    ).toBeNull();
    // 点在节点里锚节点、点在白板对象上锚对象、别处锚坐标。
    expect(anchorAt({ x: box.x + 1, y: box.y + 1 }, nodes, items)).toEqual({
      kind: "node",
      id: "n1",
    });
    expect(anchorAt({ x: 6, y: 7 }, nodes, items)).toEqual({
      kind: "item",
      id: "wb:1",
    });
    expect(anchorAt({ x: -500.4, y: -500.6 }, nodes, items)).toEqual({
      kind: "point",
      x: -500,
      y: -501,
    });
  });
});

describe("钉按屏幕距离聚合", () => {
  const groupAt = (key: string, x: number, y: number, count = 1) => ({
    group: {
      key,
      anchor: { kind: "point" as const, x, y },
      threads: [],
      count,
      open: true,
      firstAuthor: ME,
    },
    at: { x, y },
  });

  it("屏幕距离 < 24px 聚成一枚，缩放变了重算", () => {
    const pins = [
      groupAt("a", 0, 0),
      groupAt("b", 20, 0),
      groupAt("c", 100, 0),
    ];
    // 缩放 1：a 与 b 相距 20px 聚在一起，c 单独。
    expect(
      clusterPins(pins, 1).map((cluster) =>
        cluster.groups.map((group) => group.key),
      ),
    ).toEqual([["a", "b"], ["c"]]);
    // 放大到 2：a 与 b 在屏幕上相距 40px，分开。
    expect(clusterPins(pins, 2)).toHaveLength(3);
    // 缩小到 0.2：100 画布单位只有 20px，全部聚成一枚，位置是第一枚的。
    const [all] = clusterPins(pins, 0.2);
    expect(all).toMatchObject({ key: "a", at: { x: 0, y: 0 } });
    expect(all?.groups).toHaveLength(3);
    // 恰好 24px 不算挨着。
    expect(
      clusterPins([groupAt("a", 0, 0), groupAt("b", 24, 0)], 1),
    ).toHaveLength(2);
  });

  it("聚合的钉画「+N」，单枚画条数", () => {
    render(
      <TestProviders>
        <CommentPin count={7} merged={3} open color={1} label="x" />
        <CommentPin count={7} open color={1} label="y" />
      </TestProviders>,
    );
    expect(screen.getByRole("button", { name: "x" }).textContent).toBe("+3");
    expect(screen.getByRole("button", { name: "y" }).textContent).toBe("7");
  });
});

describe("正文 Markdown", () => {
  it("渲染 Markdown，裸 HTML 不执行也不出现", () => {
    const { container } = render(
      <TestProviders>
        <CommentBody
          body={
            '**粗** 与 `code`\n\n- 一\n- 二\n\n<script>window.pwned = 1</script><img src=x onerror="window.pwned=1"><b>raw</b>'
          }
        />
      </TestProviders>,
    );
    expect(container.querySelector("strong")?.textContent).toBe("粗");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
    expect(container.textContent).not.toContain("pwned");
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("链接只开 http(s)，别的协议与图片只剩文字", () => {
    const { container } = render(
      <TestProviders>
        <CommentBody
          body={
            "[ok](https://example.com) [bad](javascript:alert(1)) [data](data:text/html,x) [rel](/etc/passwd) ![pic](https://example.com/a.png)"
          }
        />
      </TestProviders>,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://example.com",
    ]);
    expect(links[0]?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.innerHTML).not.toContain("data:text");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("bad");
    expect(container.textContent).toContain("pic");
    expect(commentUrl("JavaScript:x")).toBe("");
    expect(commentUrl("HTTPS://a.b")).toBe("HTTPS://a.b");
  });

  it("提及先换掉，名字里的 Markdown 记号不生效", () => {
    expect(markdownSource(`hi @[A*b*](principal:${VERA})`)).toBe(
      `hi [@A\\*b\\*](principal:${VERA})`,
    );
    const { container } = render(
      <TestProviders>
        <CommentBody body={`**看** @[A*b*](principal:${VERA}) 这里`} />
      </TestProviders>,
    );
    const mention = container.querySelector("[data-mention]");
    expect(mention?.getAttribute("data-mention")).toBe(VERA);
    expect(mention?.textContent).toBe("@A*b*");
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("看");
  });
});

function renderThread(
  props: Partial<React.ComponentProps<typeof CommentThread>> = {},
) {
  const handlers = {
    onReply: vi.fn(),
    onResolve: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <TestProviders>
      <CommentThread
        thread={{ root: comment(), replies: [] }}
        people={PEOPLE}
        selfId={ME}
        canWrite
        isOwner={false}
        {...handlers}
        {...props}
      />
    </TestProviders>,
  );
  return handlers;
}

describe("CommentThread", () => {
  it("有写权限：解决、回复框；只读：都不画", () => {
    const handlers = renderThread();
    fireEvent.click(screen.getByRole("button", { name: "解决" }));
    expect(handlers.onResolve).toHaveBeenCalledWith("c1", true);
    expect(screen.getByRole("textbox", { name: "回复" })).toBeTruthy();
    cleanup();
    renderThread({ canWrite: false });
    expect(screen.queryByRole("button", { name: "解决" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
  });

  it("别人的评论：成员没有更多操作，owner 只能删不能改", async () => {
    renderThread({
      thread: { root: comment({ authorPrincipalId: VERA }), replies: [] },
    });
    expect(screen.queryByRole("button", { name: "更多操作" })).toBeNull();
    cleanup();
    renderThread({
      isOwner: true,
      thread: { root: comment({ authorPrincipalId: VERA }), replies: [] },
    });
    const trigger = screen.getByRole("button", { name: "更多操作" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: "删除" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "编辑" })).toBeNull();
  });

  it("正文里的提及画成 @名字，作者名取可提及的人", () => {
    renderThread({
      thread: {
        root: comment({
          authorPrincipalId: VERA,
          body: `hi @[Me](principal:${ME})`,
        }),
        replies: [],
      },
    });
    expect(screen.getByText("Vera")).toBeTruthy();
    expect(screen.getByText("@Me").getAttribute("data-mention")).toBe(ME);
  });

  it("离线时发送禁用、草稿留着", () => {
    renderThread({ offline: true });
    const box = screen.getByRole("textbox", { name: "回复" });
    fireEvent.change(box, { target: { value: "draft" } });
    expect(
      (screen.getByRole("button", { name: "发送" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((box as HTMLTextAreaElement).value).toBe("draft");
  });
});

describe("CommentComposer", () => {
  it("打 @ 选人后发出带记号的正文", async () => {
    const onSubmit = vi.fn();
    render(
      <TestProviders>
        <CommentComposer
          people={PEOPLE}
          placeholder="写评论"
          onSubmit={onSubmit}
        />
      </TestProviders>,
    );
    const box = screen.getByRole("textbox", { name: "写评论" });
    fireEvent.change(box, {
      target: { value: "看 @Ve", selectionStart: 5 },
    });
    fireEvent.click(await screen.findByRole("option", { name: "Vera" }));
    fireEvent.change(box, {
      target: { value: `${(box as HTMLTextAreaElement).value}这里` },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
    });
    expect(onSubmit).toHaveBeenCalledWith(`看 @[Vera](principal:${VERA}) 这里`);
  });
});

describe("CommentsPanelView", () => {
  it("没有评论时说怎么放；已解决的收进折叠区，只看未解决时不列", () => {
    const view = (threads: ReturnType<typeof threadsOf>, onlyOpen = false) =>
      render(
        <TestProviders>
          <CommentsPanelView
            threads={threads}
            onlyOpen={onlyOpen}
            onOnlyOpenChange={() => undefined}
            renderThread={(thread) => <p>{thread.root.body}</p>}
          />
        </TestProviders>,
      );
    view([]);
    expect(screen.getByText("在画布上点一下放评论")).toBeTruthy();
    cleanup();
    const threads = threadsOf([
      comment({ id: "a", body: "open one" }),
      comment({ id: "b", body: "done one", resolvedAtMs: 9 }),
    ]);
    view(threads);
    expect(screen.getByText("open one")).toBeTruthy();
    expect(screen.getByText("已解决 1")).toBeTruthy();
    cleanup();
    view(threads, true);
    expect(screen.queryByText("已解决 1")).toBeNull();
  });
});
