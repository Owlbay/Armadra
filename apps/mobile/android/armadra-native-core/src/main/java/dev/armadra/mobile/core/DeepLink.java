package dev.armadra.mobile.core;

import java.util.regex.Pattern;

/**
 * 原生收到的三种深链与交给页面的那一行 JS（与 iOS {@code DeepLink.swift} 同义）：
 *
 * <ul>
 *   <li>{@code armadra://pair?…}：写进 {@code #link=} 再重载，连接页拿它当初值，人点「连接」才配；
 *   <li>{@code armadra://w/<工作空间>[/n/<节点>]}：写进 {@code #push=}，页面认 {@code hashchange}；
 *   <li>{@code armadra://oauth?state=…&code=…}（或 {@code error=}）：原生 OAuth 的回调（R-56），与配对一样
 *       写进 {@code #link=} 再重载，入口在挂载前收尾。
 * </ul>
 *
 * 其余一律不认；链接按 JSON 字符串字面量嵌进脚本。
 */
public final class DeepLink {
    public enum Kind { PAIR, NODE, OAUTH }

    private static final int MAX_LENGTH = 2048;
    private static final Pattern PAIR = Pattern.compile("^armadra://pair\\?[A-Za-z0-9._~%&=:+-]+$");
    private static final Pattern OAUTH = Pattern.compile("^armadra://oauth\\?[A-Za-z0-9._~%&=:+*-]+$");
    private static final Pattern NODE =
            Pattern.compile("^armadra://w/[A-Za-z0-9._~%-]+(/n/[A-Za-z0-9._~%-]+)?/?$");

    public final Kind kind;
    public final String link;

    private DeepLink(Kind kind, String link) {
        this.kind = kind;
        this.link = link;
    }

    /** 认不出是 {@code null}。 */
    public static DeepLink parse(String link) {
        if (link == null || link.length() > MAX_LENGTH) return null;
        if (PAIR.matcher(link).matches()) return new DeepLink(Kind.PAIR, link);
        if (NODE.matcher(link).matches()) return new DeepLink(Kind.NODE, link);
        if (OAUTH.matcher(link).matches()) return new DeepLink(Kind.OAUTH, link);
        return null;
    }

    public String script() {
        String literal = literal(link);
        if (kind == Kind.PAIR || kind == Kind.OAUTH) {
            return "history.replaceState(null,'',location.pathname+'#link='+encodeURIComponent("
                    + literal + "));location.reload();";
        }
        return "location.hash='#push='+encodeURIComponent(" + literal + ");";
    }

    static String literal(String text) {
        StringBuilder out = new StringBuilder(text.length() + 2).append('"');
        for (int index = 0; index < text.length(); index++) {
            char c = text.charAt(index);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '/': out.append("\\/"); break;
                default:
                    if (c < 0x20 || c == (char) 0x2028 || c == (char) 0x2029) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.append('"').toString();
    }
}
