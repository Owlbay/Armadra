package dev.armadra.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ConnectionRulesTest {
    private static final String A = "0".repeat(32) + "." + "a".repeat(43);
    private static final String B = "1".repeat(32) + "." + "b".repeat(43);

    @Test
    public void sessionsAreKeyedBySourceAndRoute() {
        assertEquals("session.h1.direct", ConnectionRules.sessionKey("h1", "direct"));
        assertEquals("session.h1.relayed", ConnectionRules.sessionKey("h1", "relayed"));
        assertTrue(ConnectionRules.validSession("h1", "https://192.168.1.8:8443", "direct", A, B, 1000));
        assertTrue(ConnectionRules.validSession("h1", "https://relay.example.com", "relayed", A, B, 0));
        // 回环上的 http 签发方（本机联调）放行。
        assertTrue(ConnectionRules.validSession("h1", "http://127.0.0.1:8787", "relayed", A, B, 0));
    }

    @Test
    public void rejectsMalformedSessions() {
        assertFalse(ConnectionRules.validSession("bad id", "https://h:1", "direct", A, B, 0));
        assertFalse(ConnectionRules.validSession("h", "https://h:1", "satellite", A, B, 0));
        assertFalse(ConnectionRules.validSession("h", "https://h:1/path", "direct", A, B, 0));
        assertFalse(ConnectionRules.validSession("h", "http://relay.example.com", "relayed", A, B, 0));
        assertFalse(ConnectionRules.validSession("h", "https://h:1", "direct", "short", B, 0));
        assertFalse(ConnectionRules.validSession("h", "https://h:1", "direct", A, B, -1));
        assertFalse(ConnectionRules.validSession("h", "https://h:1", "direct", A, B, Double.NaN));
        assertFalse(ConnectionRules.validSession(null, "https://h:1", "direct", A, B, 0));
    }

    @Test
    public void remotesAreKeyedByServiceAndValidated() {
        String fp = "e".repeat(64);
        assertEquals("remote.personal:relay.example.com", ConnectionRules.remoteKey("personal:relay.example.com"));
        assertTrue(ConnectionRules.validRemote("personal:relay.example.com", "https://relay.example.com", "personal", "r-1", fp));
        assertTrue(ConnectionRules.validRemote("personal:relay.example.com", "https://relay.example.com", "personal", "r-1", ""));
        assertFalse(ConnectionRules.validRemote("x", "https://h:1", "other", "r", ""));
        assertFalse(ConnectionRules.validRemote("x", "https://h:1", "personal", "", ""));
        assertFalse(ConnectionRules.validRemote("x", "https://h:1", "personal", "r".repeat(5000), ""));
        assertFalse(ConnectionRules.validRemote("x", "https://h:1", "personal", "r", "XYZ"));
        assertFalse(ConnectionRules.validRemote("x", "https://h:1", "personal", "r", null));
    }

    @Test
    public void pinsAreKeyedPerOrigin() {
        assertEquals("pin.relay.example.com:443", ConnectionRules.pinKey("https://RELAY.example.com"));
        assertEquals("pin.relay.example.com:443", ConnectionRules.pinKey("https://relay.example.com:443"));
        assertEquals("pin.192.168.1.8:8443", ConnectionRules.pinKey("https://192.168.1.8:8443"));
        assertNull(ConnectionRules.pinKey("not a url"));
        assertTrue(PinPolicy.isIssuer("https://relay.example.com"));
        assertFalse(PinPolicy.isIssuer("http://relay.example.com"));
        assertFalse(PinPolicy.isIssuer("https://relay.example.com/app"));
    }
}
