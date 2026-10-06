package dev.armadra.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DeepLinkTest {
    @Test
    public void classifiesTheTwoKinds() {
        String pair = "armadra://pair?host=192.168.1.20%3A8443&ticket=abc_DEF-123&fp=" + "a".repeat(64);
        assertEquals(DeepLink.Kind.PAIR, DeepLink.parse(pair).kind);
        assertEquals(DeepLink.Kind.NODE, DeepLink.parse("armadra://w/ws_1/n/node_1").kind);
        assertEquals(DeepLink.Kind.NODE, DeepLink.parse("armadra://w/ws_1").kind);
        assertNull(DeepLink.parse("armadra://w/ws_1/x/y"));
        assertNull(DeepLink.parse("https://armadra.dev/pair"));
        assertNull(DeepLink.parse("armadra://pair?host=a&x=<script>"));
        assertNull(DeepLink.parse("armadra://w/a'+alert(1)+'"));
        assertNull(DeepLink.parse("armadra://w/" + "a".repeat(3000)));
    }

    @Test
    public void oauthCallbacksReloadLikePairing() {
        DeepLink link = DeepLink.parse("armadra://oauth?state=s_T-1&code=a*b.c%2Fd");
        assertEquals(DeepLink.Kind.OAUTH, link.kind);
        assertEquals(DeepLink.Kind.OAUTH, DeepLink.parse("armadra://oauth?state=s&error=access_denied").kind);
        assertTrue(link.script().startsWith("history.replaceState(null,'',location.pathname+'#link='+encodeURIComponent("));
        assertTrue(link.script().endsWith("location.reload();"));
        assertNull(DeepLink.parse("armadra://oauth"));
        assertNull(DeepLink.parse("armadra://oauth?state=a'+alert(1)+'"));
        assertNull(DeepLink.parse("armadra://oauthx?state=a"));
    }

    @Test
    public void joinLinksReloadLikePairing() {
        String link = "armadra://join?link=" + "0".repeat(32) + "&issuer=https%3A%2F%2Frelay.example.com&s="
                + "S".repeat(43) + "." + "c".repeat(32) + "." + "D".repeat(43);
        DeepLink parsed = DeepLink.parse(link);
        assertEquals(DeepLink.Kind.JOIN, parsed.kind);
        assertEquals(link, parsed.link);
        assertTrue(parsed.script().startsWith("history.replaceState(null,'',location.pathname+'#link='+encodeURIComponent("));
        assertTrue(parsed.script().endsWith("location.reload();"));
        assertNull(DeepLink.parse("armadra://join"));
        assertNull(DeepLink.parse("armadra://join?link=a'+alert(1)+'"));
        assertNull(DeepLink.parse("armadra://joinx?link=a"));
    }

    @Test
    public void scriptsMatchTheIosSpelling() {
        assertEquals("location.hash='#push='+encodeURIComponent(\"armadra:\\/\\/w\\/ws_1\\/n\\/node_1\");",
                DeepLink.parse("armadra://w/ws_1/n/node_1").script());
        String pair = DeepLink.parse("armadra://pair?host=h%3A1&ticket=t&fp=f").script();
        assertTrue(pair.startsWith("history.replaceState(null,'',location.pathname+'#link='+encodeURIComponent("));
        assertTrue(pair.endsWith("location.reload();"));
        assertEquals("\"a\\u2028\\\"\"", DeepLink.literal("a" + (char) 0x2028 + "\""));
    }
}
