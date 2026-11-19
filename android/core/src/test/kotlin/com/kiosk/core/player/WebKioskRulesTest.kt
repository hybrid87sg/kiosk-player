package com.kiosk.core.player

import com.kiosk.core.model.PinHash
import com.kiosk.core.model.PlayerPlaylist
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

/** The Web Kiosk rules, against the same list the Windows app is tested with. */
class WebKioskRulesTest {
    private val cases = Json.parseToJsonElement(File("../../shared/web-kiosk-rules.json").readText()).jsonObject
    private val start = cases["start"]!!.jsonPrimitive.content
    private val hosts = cases["allowed_hosts"]!!.jsonArray.map { it.jsonPrimitive.content }

    @Test fun sameSiteAndListedSitesAreAllowed() {
        for (url in cases["allowed"]!!.jsonArray.map { it.jsonPrimitive.content }) {
            assertTrue(url, WebKioskRules.isAllowed(url, start, hosts))
        }
    }

    @Test fun everythingElseIsRefused() {
        for (url in cases["refused"]!!.jsonArray.map { it.jsonPrimitive.content }) {
            assertFalse(url, WebKioskRules.isAllowed(url, start, hosts))
        }
    }

    @Test fun thePinIsCheckedAgainstTheSaltedHash() {
        val salt = "abc123"
        val hex = MessageDigest.getInstance("SHA-256").digest("$salt:2468".toByteArray()).joinToString("") { "%02x".format(it) }
        val stored = PinHash(salt, hex)
        assertTrue(WebKioskRules.pinMatches("2468", stored))
        for (wrong in listOf("2469", "", "24680")) assertFalse(wrong, WebKioskRules.pinMatches(wrong, stored))
        assertFalse(WebKioskRules.pinMatches("2468", null))
        assertFalse(WebKioskRules.pinMatches("2468", PinHash(salt, "not hex")))
    }

    @Test fun aWebKioskNeedsTheModeAndAnAddress() {
        val json = Json { ignoreUnknownKeys = true }
        val web = json.decodeFromString(PlayerPlaylist.serializer(), """{"version":"1","mode":"web","browser":{"url":"https://shop.example.com/","idle_seconds":60,"allowed_hosts":["pay.example.com"],"pin":{"salt":"s","sha256":"ab"}}}""")
        assertEquals("https://shop.example.com/", web.webKiosk?.url)
        assertEquals(60, web.webKiosk?.idleSeconds)
        assertEquals("s", web.browser?.pin?.salt)
        // A Video Kiosk keeps its settings (the PIN guards its corner) but isn't a Web Kiosk.
        val video = json.decodeFromString(PlayerPlaylist.serializer(), """{"version":"1","mode":"video","browser":{"url":"https://shop.example.com/"}}""")
        assertNull(video.webKiosk)
        // No address yet, or a server from before 0.12.0: no Web Kiosk.
        assertNull(json.decodeFromString(PlayerPlaylist.serializer(), """{"version":"1","mode":"web","browser":{"url":null}}""").webKiosk)
        assertNull(json.decodeFromString(PlayerPlaylist.serializer(), """{"version":"1"}""").webKiosk)
    }
}
