package com.kiosk.player

import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.MotionEvent
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
        // When woken at opening time, switch the screen on and show over the lock screen.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setTurnScreenOn(true)
            setShowWhenLocked(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        setContent { PlayerApp(vm) }
    }

    // Every touch and key press, before the screen's parts get it: a Web Kiosk's idle
    // countdown and the staff corner taps (see KioskInput).
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        KioskInput.touched(ev, resources.displayMetrics.density, window.decorView.width.toFloat(), window.decorView.height.toFloat())
        return super.dispatchTouchEvent(ev)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        KioskInput.active()
        return super.dispatchKeyEvent(event)
    }

    override fun onStart() {
        super.onStart()
        KeepInFront.onScreen = true
        KeepInFront.cancel() // we're on screen again
        // Asks Android to treat the player like a media app, so it isn't closed to free memory.
        KeepAliveService.start(this)
    }

    override fun onStop() {
        super.onStop()
        KeepInFront.onScreen = false
        KeepInFront.leftAt = System.currentTimeMillis()
        // Someone pressed Home or opened another app: come back in a moment.
        if (!isChangingConfigurations) KeepInFront.scheduleReturn(this)
    }
}
