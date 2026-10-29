package com.kiosk.core.network

import org.junit.Assert.assertEquals
import org.junit.Test

class ServerAddressTest {
    @Test fun internetNamesUseHttps() {
        assertEquals("https://signage.example.com/", normaliseBaseUrl("signage.example.com"))
        assertEquals("https://signage.example.com/", normaliseBaseUrl("  signage.example.com/  "))
    }

    @Test fun homeNetworkAddressesUseHttp() {
        assertEquals("http://192.168.1.20:3000/", normaliseBaseUrl("192.168.1.20:3000"))
        assertEquals("http://192.168.1.20/", normaliseBaseUrl("192.168.1.20"))
        assertEquals("http://homeassistant.local:3000/", normaliseBaseUrl("homeassistant.local:3000"))
        assertEquals("http://homeassistant.local/", normaliseBaseUrl("homeassistant.local"))
        assertEquals("http://myserver:3000/", normaliseBaseUrl("myserver:3000"))
    }

    @Test fun typedSchemeWins() {
        assertEquals("https://192.168.1.20:3000/", normaliseBaseUrl("https://192.168.1.20:3000"))
        assertEquals("http://signage.example.com/", normaliseBaseUrl("http://signage.example.com/"))
    }
}
