package com.kiosk.player

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.kiosk.player.ui.PlayerApp

/** Full screen, screen always on: what a sign needs. */
class MainActivity : ComponentActivity() {
    private val vm: PlayerViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        setContent { PlayerApp(vm) }
    }

    override fun onStart() {
        super.onStart()
        KeepInFront.cancel() // we're on screen again
    }

    override fun onStop() {
        super.onStop()
        // Someone pressed Home or opened another app: come back in a moment.
        if (!isChangingConfigurations) KeepInFront.scheduleReturn(this)
    }
}
