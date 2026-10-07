package dev.armadra.mobile.core;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ExternalUrlTest {
    @Test
    public void browsableIsHttpsOrLoopbackHttp() {
        assertTrue(ExternalUrl.browsable("https://idp.example/authorize?state=a&client_id=b"));
        assertTrue(ExternalUrl.browsable("http://127.0.0.1:5556/dex/auth?x=1"));
        assertTrue(ExternalUrl.browsable("http://localhost:5556/"));
        assertFalse(ExternalUrl.browsable("http://idp.example/authorize"));
        assertFalse(ExternalUrl.browsable("https://user:pw@idp.example/"));
        assertFalse(ExternalUrl.browsable("javascript:alert(1)"));
        assertFalse(ExternalUrl.browsable("armadra://oauth?state=a"));
        assertFalse(ExternalUrl.browsable("intent://scan/#Intent;scheme=zxing;end"));
        assertFalse(ExternalUrl.browsable(null));
        assertFalse(ExternalUrl.browsable("https://" + "a".repeat(5000)));
    }

    @Test
    public void unifiedPushEndpointMatchesTheCoreRule() {
        assertTrue(ExternalUrl.unifiedPushEndpoint("https://ntfy.example/upAbc?up=1"));
        assertTrue(ExternalUrl.unifiedPushEndpoint("http://127.0.0.1:8093/upAbc?up=1"));
        assertFalse(ExternalUrl.unifiedPushEndpoint("http://ntfy.example/upAbc"));
        assertFalse(ExternalUrl.unifiedPushEndpoint("https://ntfy.example/upAbc#x"));
        assertFalse(ExternalUrl.unifiedPushEndpoint("https://u:p@ntfy.example/upAbc"));
        assertFalse(ExternalUrl.unifiedPushEndpoint("content://ntfy/upAbc"));
    }
}
