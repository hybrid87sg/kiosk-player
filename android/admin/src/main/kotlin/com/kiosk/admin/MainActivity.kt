package com.kiosk.admin

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.kiosk.admin.ui.AdminApp
import com.kiosk.admin.ui.theme.KioskTheme

/** The one screen of the app; everything inside is drawn with Jetpack Compose. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = application as KioskAdminApplication
        setContent {
            KioskTheme {
                AdminApp(app)
            }
        }
    }
}
