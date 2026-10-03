import * as React from "react";
import { ChevronDown, MoreHorizontal, Plus, Save, Search } from "lucide-react";

import { useT } from "@/app/preferences-store";
import { agentLabel } from "@/agent/launch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/ui/accordion";
import {
  ResponsiveDialog,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/panels/ResponsiveDialog";
import { TABS_CONTENT_FOCUS } from "@/panels/tabs-focus";
import { AgentAvatar } from "@/ui/agent-avatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/ui/alert";
import { Avatar, AvatarFallback, AvatarGroup } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { BrandMark } from "@/ui/brand-mark";
import { Button } from "@/ui/button";
import { ButtonGroup } from "@/ui/button-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/card";
import { Checkbox } from "@/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/ui/collapsible";
import { ColorDot } from "@/ui/color-dot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/ui/empty";
import { Field, FieldError, FieldLabel } from "@/ui/field";
import { IconButton } from "@/ui/icon-button";
import { Input } from "@/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/ui/input-group";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/ui/input-otp";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/ui/item";
import { Kbd, KbdGroup } from "@/ui/kbd";
import { Label } from "@/ui/label";
import { MemberDot, memberColorVar } from "@/ui/member-dot";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/ui/hover-card";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Progress } from "@/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/select";
import { ScrollArea } from "@/ui/scroll-area";
import { Separator } from "@/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/ui/sheet";
import { Skeleton } from "@/ui/skeleton";
import { Slider } from "@/ui/slider";
import { Spinner } from "@/ui/spinner";
import { StatusPill } from "@/ui/status-pill";
import { Switch } from "@/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";
import { Textarea } from "@/ui/textarea";
import { Toggle } from "@/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import {
  ACCORDION_ITEMS,
  AGENT_IDS,
  BADGE_VARIANTS,
  BUTTON_VARIANTS,
  MEMBERS,
  SESSIONS,
  SHORTCUT,
  STATUS_TONES,
} from "../fixtures/components";

/**
 * `components` 分区（设计展示页 §2.1）：设计系统 §3.1 + §3.2 的组件。
 *
 * 上半是状态矩阵（§3.4）：每个控件一行，六列状态。悬停与焦点两列用
 * `force-state.css` 的 `data-hover` / `data-focus` 强制画出来；「加载中」只有
 * 按钮类控件有（`Spinner` 替换图标，宽度不变），其余格子留空。
 * 下半是不分状态的组件样本。
 */

const STATES = [
  "default",
  "hover",
  "focus",
  "disabled",
  "invalid",
  "loading",
] as const;
type State = (typeof STATES)[number];

/** 每种状态对应的 DOM 属性；`loading` 由各行自己画。 */
function stateProps(state: State) {
  return {
    ...(state === "hover" ? { "data-hover": "" } : {}),
    ...(state === "focus" ? { "data-focus": "" } : {}),
    ...(state === "disabled" ? { disabled: true } : {}),
    ...(state === "invalid" ? { "aria-invalid": true } : {}),
  };
}

type Row = {
  name: string;
  render: (state: State) => React.ReactNode;
};

function useRows(): Row[] {
  const t = useT();
  const loading = <Spinner aria-label={t("showcase.state.loading")} />;
  const buttons: Row[] = BUTTON_VARIANTS.map((variant) => ({
    name: `button · ${variant}`,
    render: (state) => (
      <Button
        variant={variant}
        size="sm"
        {...stateProps(state)}
        {...(state === "loading" ? { disabled: true } : {})}
      >
        {state === "loading" ? loading : <Save />}
        {t("showcase.sample.save")}
      </Button>
    ),
  }));
  return [
    ...buttons,
    {
      name: "icon-button",
      render: (state) => (
        <IconButton
          size="cluster"
          label={t("showcase.sample.more")}
          {...stateProps(state)}
          {...(state === "loading" ? { disabled: true } : {})}
        >
          {state === "loading" ? loading : <MoreHorizontal />}
        </IconButton>
      ),
    },
    {
      name: "input",
      render: (state) =>
        state === "loading" ? null : (
          <Input
            className="h-8 w-36"
            aria-label={t("showcase.sample.name")}
            placeholder={t("showcase.sample.search")}
            {...stateProps(state)}
          />
        ),
    },
    {
      name: "textarea",
      render: (state) =>
        state === "loading" ? null : (
          <Textarea
            rows={2}
            className="min-h-0 w-36"
            aria-label={t("showcase.sample.details")}
            {...stateProps(state)}
          />
        ),
    },
    {
      name: "select",
      render: (state) =>
        state === "loading" ? null : (
          <Select defaultValue="1" disabled={state === "disabled"}>
            <SelectTrigger
              size="sm"
              className="w-36"
              aria-label={t("showcase.sample.status")}
              {...stateProps(state)}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t("showcase.sample.option", { n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ),
    },
    {
      name: "switch",
      render: (state) =>
        state === "loading" ? null : (
          <Switch
            defaultChecked
            aria-label={t("showcase.sample.enabled")}
            {...stateProps(state)}
          />
        ),
    },
    {
      name: "checkbox",
      render: (state) =>
        state === "loading" ? null : (
          <Checkbox
            defaultChecked
            aria-label={t("showcase.sample.enabled")}
            {...stateProps(state)}
          />
        ),
    },
    {
      name: "radio-group",
      render: (state) =>
        state === "loading" ? null : (
          <RadioGroup
            defaultValue="a"
            className="flex gap-2"
            aria-label={t("showcase.sample.status")}
            disabled={state === "disabled"}
          >
            <RadioGroupItem
              value="a"
              aria-label={t("showcase.sample.option", { n: 1 })}
              {...stateProps(state)}
            />
            <RadioGroupItem
              value="b"
              aria-label={t("showcase.sample.option", { n: 2 })}
            />
          </RadioGroup>
        ),
    },
    {
      name: "toggle",
      render: (state) =>
        state === "loading" ? null : (
          <Toggle
            size="sm"
            aria-label={t("showcase.sample.search")}
            {...stateProps(state)}
          >
            <Search />
          </Toggle>
        ),
    },
    {
      name: "slider",
      render: (state) =>
        state === "loading" ? null : (
          <Slider
            className="w-28"
            defaultValue={[40]}
            aria-label={t("showcase.sample.volume")}
            disabled={state === "disabled"}
            {...(state === "hover" ? { "data-hover": "" } : {})}
            {...(state === "focus" ? { "data-focus": "" } : {})}
          />
        ),
    },
  ];
}

function StateMatrix() {
  const t = useT();
  const rows = useRows();
  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-x-3 border-spacing-y-2 text-left">
        <thead>
          <tr>
            <th />
            {STATES.map((state) => (
              <th
                key={state}
                scope="col"
                className="text-[length:var(--text-caption)] font-medium text-muted-foreground"
              >
                {t(`showcase.state.${state}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <th
                scope="row"
                className="pr-2 font-mono text-[length:var(--text-caption)] font-normal whitespace-nowrap text-muted-foreground"
              >
                {row.name}
              </th>
              {STATES.map((state) => (
                <td key={state} className="align-middle">
                  {row.render(state)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 一格样本：上面组件，下面组件名。 */
function Sample({
  name,
  children,
  wide = false,
}: {
  name: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      data-sample={name}
      className={
        wide
          ? "flex w-full max-w-md flex-col gap-2"
          : "flex flex-col items-start gap-2"
      }
    >
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <span className="font-mono text-[length:var(--text-caption)] text-muted-foreground">
        {name}
      </span>
    </div>
  );
}

function Gallery() {
  const t = useT();
  const [open, setOpen] = React.useState(true);
  const [code, setCode] = React.useState("204");
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-6">
      <Sample name="badge">
        {BADGE_VARIANTS.map((variant) => (
          <Badge key={variant} variant={variant}>
            {t("showcase.sample.owner")}
          </Badge>
        ))}
      </Sample>
      <Sample name="status-pill">
        {STATUS_TONES.map((tone) => (
          <StatusPill
            key={tone}
            tone={tone}
            label={t(`showcase.tone.${tone}`)}
          />
        ))}
      </Sample>
      <Sample name="agent-avatar">
        {AGENT_IDS.map((id) => (
          <AgentAvatar key={id} agentId={id} size={24} />
        ))}
        <AgentAvatar agentId="ama" size={20} />
        <AgentAvatar agentId="ama" size={32} />
      </Sample>
      <Sample name="avatar">
        <AvatarGroup>
          {MEMBERS.slice(0, 4).map((member) => (
            <Avatar key={member.index} size="sm" title={member.name}>
              <AvatarFallback
                style={{
                  backgroundColor: memberColorVar(member.index),
                  color: "var(--on-agent)",
                }}
              >
                {Array.from(member.name)[0]}
              </AvatarFallback>
            </Avatar>
          ))}
        </AvatarGroup>
      </Sample>
      <Sample name="member-dot">
        {MEMBERS.map((member) => (
          <MemberDot
            key={member.index}
            index={member.index}
            name={member.name}
          />
        ))}
      </Sample>
      <Sample name="color-dot">
        <ColorDot color="var(--brand)" />
        <ColorDot color="var(--agent-ama)" selected />
      </Sample>
      <Sample name="kbd">
        <KbdGroup>
          {SHORTCUT.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </KbdGroup>
      </Sample>
      <Sample name="progress · skeleton · spinner">
        <Progress value={62} className="w-32" />
        <Skeleton className="h-4 w-24" />
        <Spinner aria-label={t("showcase.state.loading")} />
      </Sample>
      <Sample name="tabs">
        <Tabs defaultValue="session">
          <TabsList>
            <TabsTrigger value="session">
              {t("showcase.sample.session")}
            </TabsTrigger>
            <TabsTrigger value="terminal">
              {t("showcase.sample.terminal")}
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="session"
            className={`px-1 py-1.5 text-muted-foreground ${TABS_CONTENT_FOCUS}`}
          >
            {SESSIONS[0].title}
          </TabsContent>
          <TabsContent
            value="terminal"
            className={`px-1 py-1.5 text-muted-foreground ${TABS_CONTENT_FOCUS}`}
          >
            {SESSIONS[1].title}
          </TabsContent>
        </Tabs>
      </Sample>
      <Sample name="toggle-group · button-group">
        <ToggleGroup
          type="single"
          defaultValue="session"
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="session">
            {t("showcase.sample.session")}
          </ToggleGroupItem>
          <ToggleGroupItem value="terminal">
            {t("showcase.sample.terminal")}
          </ToggleGroupItem>
        </ToggleGroup>
        <ButtonGroup>
          <Button variant="outline" size="sm">
            {t("showcase.sample.cancel")}
          </Button>
          <Button variant="outline" size="sm">
            {t("showcase.sample.save")}
          </Button>
        </ButtonGroup>
      </Sample>
      <Sample name="input-group · input-otp">
        <InputGroup className="w-48">
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t("showcase.sample.search")}
            placeholder={t("showcase.sample.search")}
          />
        </InputGroup>
        <InputOTP
          maxLength={6}
          value={code}
          onChange={setCode}
          aria-label={t("showcase.sample.code")}
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <InputOTPSlot key={index} index={index} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </Sample>
      <Sample name="field · label" wide>
        <Field data-invalid>
          <FieldLabel htmlFor="showcase-field">
            {t("showcase.sample.name")}
          </FieldLabel>
          <Input id="showcase-field" aria-invalid className="h-8" />
          <FieldError>{t("showcase.sample.nameRequired")}</FieldError>
        </Field>
        <div className="flex items-center gap-2">
          <Checkbox id="showcase-check" />
          <Label htmlFor="showcase-check">{t("showcase.sample.enabled")}</Label>
        </div>
      </Sample>
      <Sample name="alert" wide>
        <Alert>
          <AlertTitle>{t("showcase.sample.alertTitle")}</AlertTitle>
          <AlertDescription>{t("showcase.sample.alertBody")}</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <AlertTitle>{t("showcase.sample.alertTitle")}</AlertTitle>
        </Alert>
      </Sample>
      <Sample name="card · item" wide>
        <Card className="w-full">
          <CardHeader>
            <CardTitle>{SESSIONS[0].title}</CardTitle>
            <CardDescription>{agentLabel(SESSIONS[0].agent)}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {SESSIONS.map((session) => (
              <Item key={session.id} variant="outline" size="sm">
                <ItemMedia>
                  <AgentAvatar agentId={session.agent} size={24} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{session.title}</ItemTitle>
                  <ItemDescription>{session.time}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <StatusPill
                    tone={session.tone}
                    label={t(`showcase.tone.${session.tone}`)}
                  />
                </ItemActions>
              </Item>
            ))}
          </CardContent>
        </Card>
      </Sample>
      <Sample name="table" wide>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("showcase.sample.session")}</TableHead>
              <TableHead>{t("showcase.sample.status")}</TableHead>
              <TableHead className="text-right">
                {t("showcase.sample.time")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SESSIONS.map((session) => (
              <TableRow key={session.id}>
                <TableCell>{session.title}</TableCell>
                <TableCell>
                  <StatusPill
                    tone={session.tone}
                    label={t(`showcase.tone.${session.tone}`)}
                  />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {session.time}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Sample>
      <Sample name="accordion · collapsible" wide>
        <Accordion type="single" collapsible defaultValue="read">
          {ACCORDION_ITEMS.map((item) => (
            <AccordionItem key={item.id} value={item.id}>
              <AccordionTrigger className="font-mono text-[length:var(--text-code)]">
                {item.title}
              </AccordionTrigger>
              <AccordionContent>{item.body}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              <ChevronDown />
              {t("showcase.sample.details")}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2 text-muted-foreground">
            {SESSIONS[1].title}
          </CollapsibleContent>
        </Collapsible>
      </Sample>
      <Sample name="tooltip · dropdown-menu · separator">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm">
              <Plus />
              {t("showcase.sample.create")}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("showcase.sample.create")}</TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="h-6" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t("showcase.sample.more")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>{t("showcase.sample.save")}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive">
              {t("showcase.sample.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Sample>
      <Sample name="responsive-dialog · alert-dialog · sheet">
        <ResponsiveDialog>
          <ResponsiveDialogTrigger asChild>
            <Button variant="outline" size="sm">
              <Plus />
              {t("showcase.sample.create")}
            </Button>
          </ResponsiveDialogTrigger>
          <ResponsiveDialogContent>
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle>
                {t("showcase.sample.create")}
              </ResponsiveDialogTitle>
            </ResponsiveDialogHeader>
            <Field>
              <FieldLabel htmlFor="showcase-dialog-name">
                {t("showcase.sample.name")}
              </FieldLabel>
              <Input id="showcase-dialog-name" />
            </Field>
            <ResponsiveDialogFooter>
              <ResponsiveDialogClose asChild>
                <Button variant="outline">{t("showcase.sample.cancel")}</Button>
              </ResponsiveDialogClose>
              <Button>{t("showcase.sample.save")}</Button>
            </ResponsiveDialogFooter>
          </ResponsiveDialogContent>
        </ResponsiveDialog>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" size="sm">
              {t("showcase.sample.delete")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("showcase.sample.delete")}</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("showcase.sample.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction variant="destructive">
                {t("showcase.sample.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="sm">
              {t("showcase.sample.details")}
            </Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>{t("showcase.sample.details")}</SheetTitle>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      </Sample>
      <Sample name="popover · hover-card · brand-mark">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              {t("showcase.sample.more")}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 text-xs">
            {SESSIONS[0].title}
          </PopoverContent>
        </Popover>
        <HoverCard>
          <HoverCardTrigger asChild>
            <Button variant="link" size="sm">
              {agentLabel(SESSIONS[0].agent)}
            </Button>
          </HoverCardTrigger>
          <HoverCardContent className="w-56 text-xs">
            {SESSIONS[0].title}
          </HoverCardContent>
        </HoverCard>
        <BrandMark className="size-6" />
      </Sample>
      <Sample name="scroll-area" wide>
        <ScrollArea className="h-24 w-full rounded-[var(--r-control)] border">
          <div className="flex flex-col gap-1 p-2">
            {[...SESSIONS, ...SESSIONS].map((session, index) => (
              <span key={`${session.id}-${index}`} className="truncate">
                {session.title}
              </span>
            ))}
          </div>
        </ScrollArea>
      </Sample>
      <Sample name="empty" wide>
        <Empty className="border border-dashed border-border">
          <EmptyHeader>
            <EmptyTitle>{t("showcase.sample.emptyTitle")}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm">{t("showcase.sample.create")}</Button>
          </EmptyContent>
        </Empty>
      </Sample>
    </div>
  );
}

export default function ComponentsSection() {
  return (
    <div className="flex flex-col gap-8">
      <StateMatrix />
      <Gallery />
    </div>
  );
}
