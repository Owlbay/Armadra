import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Check } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ColorDot } from "@/ui/color-dot";
import { IconButton } from "@/ui/icon-button";
import { Kbd, KbdGroup } from "@/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { STATUS_PILL_LABELS, StatusPill } from "@/ui/status-pill";
import { Switch } from "@/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/ui/accordion";
import { AgentAvatar } from "@/ui/agent-avatar";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Avatar, AvatarFallback } from "@/ui/avatar";
import { ButtonGroup } from "@/ui/button-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { Empty, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/ui/input-otp";
import { Item, ItemContent, ItemTitle } from "@/ui/item";
import { Label } from "@/ui/label";
import { MemberDot, memberColorVar } from "@/ui/member-dot";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import { Skeleton } from "@/ui/skeleton";
import { Spinner } from "@/ui/spinner";
import { Table, TableBody, TableCell, TableRow } from "@/ui/table";

beforeAll(() => {
  // Radix 的定位层（floating-ui）在 jsdom 下需要这两个 API
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const element = Element.prototype as unknown as Record<string, unknown>;
  if (!("hasPointerCapture" in element)) {
    element.hasPointerCapture = () => false;
    element.setPointerCapture = () => {};
    element.releasePointerCapture = () => {};
  }
});

afterEach(cleanup);

describe("Button（shadcn 生成）", () => {
  it("默认是 type=button 之外的原生按钮，variant/size 落到 data 属性上", () => {
    render(
      <Button variant="destructive" size="sm">
        删除
      </Button>,
    );
    const button = screen.getByRole("button", { name: "删除" });
    expect(button.dataset.slot).toBe("button");
    expect(button.dataset.variant).toBe("destructive");
    expect(button.dataset.size).toBe("sm");
  });

  it("className 通过 twMerge 覆盖内置尺寸而不是叠加", () => {
    render(<Button className="h-12">高</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("h-12");
    expect(cls).not.toMatch(/\bh-8\b/);
  });

  it("asChild 把样式套到子元素上", () => {
    render(
      <Button asChild>
        <a href="#a">链接</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "链接" }).dataset.slot).toBe(
      "button",
    );
  });
});

describe("StatusPill", () => {
  it("按 tone 打标记并显示文案", () => {
    render(
      <StatusPill tone="attention" label={STATUS_PILL_LABELS.attention} />,
    );
    const pill = screen
      .getByText("Needs you")
      .closest("[data-slot='status-pill']");
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute("data-tone")).toBe("attention");
  });

  it("working / attention 默认脉冲，failed 不脉冲", () => {
    const { container, rerender } = render(
      <StatusPill tone="working" label="Running" />,
    );
    const dot = () => container.querySelector("[data-slot='status-pill-dot']")!;
    expect(dot().className).toContain("anim-dot-pulse");

    rerender(<StatusPill tone="failed" label="Turn failed" />);
    expect(dot().className).not.toContain("anim-dot-pulse");
  });

  it("pulse 可以显式关掉", () => {
    const { container } = render(
      <StatusPill tone="working" label="Running" pulse={false} />,
    );
    expect(
      container.querySelector("[data-slot='status-pill-dot']")!.className,
    ).not.toContain("anim-dot-pulse");
  });

  it("支持尾随内容（队列的 ▶）", () => {
    const { container } = render(
      <StatusPill tone="queued" label="Queued" trailing="▶" />,
    );
    expect(
      container.querySelector("[data-slot='status-pill']")!.textContent,
    ).toBe("Queued▶");
  });
});

describe("ColorDot", () => {
  it("supports semantic status indicators and whiteboard colour swatches", () => {
    const { container } = render(<ColorDot color="#0a84ff" size={8} />);
    const dot = container.querySelector(
      "[data-slot='color-dot']",
    ) as HTMLElement;
    expect(dot.style.width).toBe("8px");
    expect(dot.style.backgroundColor).toBe("rgb(10, 132, 255)");
  });
});

describe("IconButton", () => {
  it("label 变成无障碍名称", () => {
    render(<IconButton label="整理画布" />);
    expect(screen.getByRole("button", { name: "整理画布" })).toBeTruthy();
  });

  it("cluster 是 34×34，inline 是 26×26", () => {
    const { rerender } = render(<IconButton label="设置" size="cluster" />);
    expect(screen.getByRole("button").className).toContain("size-[28px]");
    rerender(<IconButton label="关闭" size="inline" />);
    expect(screen.getByRole("button").className).toContain("size-[24px]");
  });

  it("active 同时反映在 data-active 和 aria-pressed 上", () => {
    render(<IconButton label="固定侧栏" active />);
    const button = screen.getByRole("button", { name: "固定侧栏" });
    expect(button.dataset.active).toBe("true");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("其余生成组件的冒烟测试", () => {
  it("Badge 渲染内容", () => {
    render(<Badge variant="secondary">Claude</Badge>);
    expect(screen.getByText("Claude").dataset.slot).toBe("badge");
  });

  it("Kbd 渲染成 <kbd>", () => {
    render(
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>,
    );
    expect(screen.getByText("⌘").tagName).toBe("KBD");
  });

  it("Switch 可以用键盘切换", () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="启用消息" onCheckedChange={onCheckedChange} />);
    const toggle = screen.getByRole("switch", { name: "启用消息" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("Popover 由触发器控制开合", () => {
    render(
      <Popover>
        <PopoverTrigger>打开</PopoverTrigger>
        <PopoverContent>内容</PopoverContent>
      </Popover>,
    );
    expect(screen.queryByText("内容")).toBeNull();
    fireEvent.click(screen.getByText("打开"));
    expect(screen.getByText("内容")).toBeTruthy();
  });
});

describe("设计系统 §3.2 新增的生成组件", () => {
  it("每个组件都能渲染并带 data-slot", () => {
    const { container } = render(
      <div>
        <Avatar>
          <AvatarFallback>A</AvatarFallback>
        </Avatar>
        <Card>
          <CardHeader>
            <CardTitle>卡片</CardTitle>
          </CardHeader>
          <CardContent>正文</CardContent>
        </Card>
        <Alert variant="destructive">
          <AlertTitle>离线</AlertTitle>
          <AlertDescription>重连中</AlertDescription>
        </Alert>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>没有会话</EmptyTitle>
          </EmptyHeader>
        </Empty>
        <Skeleton className="h-4 w-20" />
        <Spinner aria-label="加载中" />
        <Label htmlFor="name">名称</Label>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>行</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Item>
          <ItemContent>
            <ItemTitle>设备</ItemTitle>
          </ItemContent>
        </Item>
        <ButtonGroup>
          <Button variant="outline">允许</Button>
          <Button variant="outline">拒绝</Button>
        </ButtonGroup>
      </div>,
    );
    for (const slot of [
      "avatar",
      "card",
      "alert",
      "empty",
      "skeleton",
      "spinner",
      "label",
      "table",
      "item",
      "button-group",
    ]) {
      expect(
        container.querySelector(`[data-slot='${slot}']`),
        slot,
      ).not.toBeNull();
    }
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("status", { name: "加载中" })).toBeTruthy();
  });

  it("Checkbox 与 RadioGroup 可以点选", () => {
    const onChecked = vi.fn();
    const onValue = vi.fn();
    render(
      <>
        <Checkbox aria-label="记住" onCheckedChange={onChecked} />
        <RadioGroup aria-label="角色" onValueChange={onValue}>
          <RadioGroupItem value="driver" aria-label="驱动" />
          <RadioGroupItem value="editor" aria-label="编辑" />
        </RadioGroup>
      </>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "记住" }));
    expect(onChecked).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("radio", { name: "编辑" }));
    expect(onValue).toHaveBeenCalledWith("editor");
  });

  it("Collapsible 与 Accordion 由触发器展开", () => {
    render(
      <>
        <Collapsible>
          <CollapsibleTrigger>工具调用</CollapsibleTrigger>
          <CollapsibleContent>参数</CollapsibleContent>
        </Collapsible>
        <Accordion type="single" collapsible>
          <AccordionItem value="a">
            <AccordionTrigger>第一组</AccordionTrigger>
            <AccordionContent>记录</AccordionContent>
          </AccordionItem>
        </Accordion>
      </>,
    );
    expect(screen.queryByText("参数")).toBeNull();
    fireEvent.click(screen.getByText("工具调用"));
    expect(screen.getByText("参数")).toBeTruthy();
    const trigger = screen.getByRole("button", { name: "第一组" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("InputOTP 渲染六个格子", () => {
    const { container } = render(
      <InputOTP maxLength={6} aria-label="验证码">
        <InputOTPGroup>
          {Array.from({ length: 6 }, (_, index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </InputOTP>,
    );
    expect(
      container.querySelectorAll("[data-slot='input-otp-slot']"),
    ).toHaveLength(6);
  });

  it("Field 把标签、控件、错误组成一组", () => {
    render(
      <Field data-invalid="true">
        <FieldLabel htmlFor="workspace">工作空间</FieldLabel>
        <Input id="workspace" aria-invalid="true" />
        <FieldError>不能为空</FieldError>
      </Field>,
    );
    const input = screen.getByLabelText("工作空间");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("不能为空");
  });
});

describe("§3.4 状态矩阵", () => {
  it.each([
    ["Button", () => <Button>动作</Button>, "button"],
    ["Checkbox", () => <Checkbox aria-label="动作" />, "checkbox"],
    [
      "RadioGroupItem",
      () => (
        <RadioGroup>
          <RadioGroupItem value="a" aria-label="动作" />
        </RadioGroup>
      ),
      "radio",
    ],
    ["Input", () => <Input aria-label="动作" />, "textbox"],
  ] as const)(
    "%s：focus-visible 3px 50% 环、disabled 50% 不透明、aria-invalid 危险边 + 20% 环",
    (_, make, role) => {
      render(make());
      const cls = screen.getByRole(role, { name: "动作" }).className;
      expect(cls).toContain("focus-visible:ring-3");
      expect(cls).toContain("focus-visible:ring-ring/50");
      expect(cls).toContain("disabled:opacity-50");
      expect(cls).toContain("aria-invalid:border-destructive");
      expect(cls).toContain("aria-invalid:ring-destructive/20");
    },
  );

  it("disabled 真的不可交互", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        保存
      </Button>,
    );
    const button = screen.getByRole("button", { name: "保存" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.className).toContain("disabled:pointer-events-none");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("loading：Spinner 替换图标，按钮仍是同一个元素", () => {
    const { rerender } = render(
      <Button size="sm">
        <Check data-testid="icon" />
        保存
      </Button>,
    );
    const button = screen.getByRole("button", { name: "保存" });
    rerender(
      <Button size="sm" disabled>
        <Spinner aria-label="保存中" />
        保存
      </Button>,
    );
    expect(screen.getByRole("button")).toBe(button);
    expect(screen.queryByTestId("icon")).toBeNull();
    expect(button.querySelector("[data-slot='spinner']")).not.toBeNull();
  });
});

describe("AgentAvatar", () => {
  it("内置 Agent：首字母、标识色底、--on-agent 字", () => {
    render(<AgentAvatar agentId="codex" />);
    const avatar = screen.getByRole("img", { name: "Codex" });
    expect(avatar.dataset.avatarSize).toBe("24");
    expect(avatar.dataset.size).toBe("sm");
    const fallback = avatar.querySelector(
      "[data-slot='avatar-fallback']",
    ) as HTMLElement;
    expect(fallback.textContent).toBe("C");
    expect(fallback.style.backgroundColor).toBe("var(--agent-codex)");
    expect(fallback.style.color).toBe("var(--on-agent)");
  });

  it("20 / 32 两档尺寸", () => {
    const { rerender } = render(<AgentAvatar agentId="claude" size={20} />);
    expect(screen.getByRole("img").className).toContain("size-5");
    rerender(<AgentAvatar agentId="claude" size={32} />);
    expect(screen.getByRole("img").dataset.size).toBe("default");
  });
});

describe("MemberDot", () => {
  it("按序号取 --member-n，带 title", () => {
    const { container } = render(<MemberDot index={3} name="Ada" />);
    const dot = container.querySelector(
      "[data-slot='color-dot']",
    ) as HTMLElement;
    expect(dot.style.backgroundColor).toBe("var(--member-3)");
    expect(dot.title).toBe("Ada");
  });

  it("超过八个按环回绕", () => {
    expect(memberColorVar(1)).toBe("var(--member-1)");
    expect(memberColorVar(8)).toBe("var(--member-8)");
    expect(memberColorVar(9)).toBe("var(--member-1)");
    expect(memberColorVar(18)).toBe("var(--member-2)");
  });
});
