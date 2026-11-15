/**
 * 专注计时引擎 —— 纯状态机
 *
 * 设计要点：
 * 1. 不持有定时器、不调震动、不碰 UI。页面和微服务各自驱动同一份引擎，
 *    保证"前台跑"和"后台跑"行为完全一致。
 * 2. 全程用绝对时间戳（Date.now()），不用 tick 计数累加。
 *    手表息屏时 JS 可能被挂起，tick 会漏掉几百次；用时间戳就能在恢复后
 *    一次性算出正确状态，而不是"把丢掉的时间补成 0 秒"。
 * 3. tick() 返回事件数组，每个事件带 lag（应该触发的时刻到现在差了多久）。
 *    调用方据此判断：lag 很小的才震动，lag 很大的（睡过头了）只记账不震，
 *    避免恢复瞬间连震一串。
 */

import { pickGap, randInt } from './plan'

const IDLE = 'idle'
const FOCUS = 'focus'
const MICRO = 'micro'
const REST = 'rest'

function blank() {
  return {
    phase: IDLE,
    running: false,
    startedAt: 0,
    focusEndsAt: 0,
    nextMicroAt: 0,
    microEndsAt: 0,
    restEndsAt: 0,
    rounds: 0,
    gapSec: 0,
    microSec: 0,
    pausedAt: 0
  }
}

/**
 * 排下一次微休息。
 * 与原版一致：间隔从"上次微休息结束"这个时刻起算，
 * 且不能超出当前专注阶段的剩余时间。
 */
function planMicro(s, fromTs, cfg) {
  const elapsedSec = Math.max(0, (fromTs - s.startedAt) / 1000)
  const focusSec = Math.max(1, (s.focusEndsAt - s.startedAt) / 1000)

  let gap = pickGap({
    algorithm: cfg.algorithm,
    gapSec: cfg.gapMin * 60,
    gapMaxSec: cfg.gapMaxMin * 60,
    elapsedSec,
    focusSec
  })

  s.microSec = randInt(cfg.microMinSec, cfg.microMaxSec)

  // 专注收尾阶段不再排新的微休息：
  // 否则会排出一个"刚休息完 12 秒又休息"的怪异节奏，
  // 剩余时间不够走完一轮（间隔 + 休息 + 余量）时直接放弃这一轮。
  const remainSec = (s.focusEndsAt - fromTs) / 1000
  const need = gap + s.microSec + 5
  if (remainSec < need) {
    s.gapSec = gap
    // 排到专注结束之后，tick 里 focusEnd 的判断优先，等于不触发
    s.nextMicroAt = s.focusEndsAt + 1
    return
  }

  s.gapSec = gap
  s.nextMicroAt = fromTs + gap * 1000
}

function makeEngine(initial) {
  let s = initial ? Object.assign(blank(), initial) : blank()
  let lastCfg = null

  function start(now, cfg) {
    s = blank()
    s.running = true
    s.startedAt = now
    s.focusEndsAt = now + cfg.focusMin * 60000
    s.phase = FOCUS
    planMicro(s, now, cfg)
    return snapshot(now, cfg)
  }

  function pause(now) {
    if (!s.running) return snapshot(now, lastCfg)
    s.running = false
    s.pausedAt = now
    return snapshot(now, lastCfg)
  }

  /** 恢复：把所有绝对时间戳整体平移暂停时长，时间轴保持连续 */
  function resume(now) {
    if (s.running || !s.pausedAt) return snapshot(now, lastCfg)
    const d = now - s.pausedAt
    s.startedAt += d
    s.focusEndsAt += d
    s.nextMicroAt += d
    s.microEndsAt += d
    s.restEndsAt += d
    s.pausedAt = 0
    s.running = true
    return snapshot(now, lastCfg)
  }

  function stop(now) {
    const rounds = s.rounds
    s = blank()
    return { snapshot: snapshot(now, lastCfg), rounds }
  }

  /**
   * 推进到 now。返回事件列表；调用方按 lag 决定是否震动。
   */
  function tick(now, cfg) {
    if (cfg) lastCfg = cfg
    const events = []
    if (!s.running || s.phase === IDLE) return { events, state: snapshot(now, cfg) }

    let guard = 0
    while (guard++ < 500) {
      if (s.phase === FOCUS) {
        // 专注到点优先于微休息，避免最后一刻还弹一个没意义的休息
        if (now >= s.focusEndsAt) {
          events.push({ type: 'focusEnd', lag: now - s.focusEndsAt })
          endFocus(cfg)
          continue
        }
        if (now >= s.nextMicroAt) {
          events.push({ type: 'microStart', lag: now - s.nextMicroAt })
          s.phase = MICRO
          s.microEndsAt = s.nextMicroAt + s.microSec * 1000
          // 微休息不许越过专注结束点
          if (s.microEndsAt > s.focusEndsAt) s.microEndsAt = s.focusEndsAt
          continue
        }
        break
      }

      if (s.phase === MICRO) {
        if (now >= s.focusEndsAt) {
          events.push({ type: 'focusEnd', lag: now - s.focusEndsAt })
          endFocus(cfg)
          continue
        }
        if (now >= s.microEndsAt) {
          events.push({ type: 'microEnd', lag: now - s.microEndsAt })
          s.rounds += 1
          s.phase = FOCUS
          planMicro(s, s.microEndsAt, cfg)
          continue
        }
        break
      }

      if (s.phase === REST) {
        if (now >= s.restEndsAt) {
          events.push({ type: 'restEnd', lag: now - s.restEndsAt })
          s.phase = IDLE
          s.running = false
          continue
        }
        break
      }

      break
    }

    return { events, state: snapshot(now, cfg) }
  }

  function endFocus(cfg) {
    if (cfg && cfg.autoRest) {
      s.phase = REST
      s.restEndsAt = s.focusEndsAt + cfg.restMin * 60000
    } else {
      s.phase = IDLE
      s.running = false
    }
  }

  /**
   * 环形进度：满格 → 0（倒计时环）。三个阶段全部走这条。
   *
   * 为什么全程都用"剩余比例"而不是"已过比例"：
   * 用户要的是"开始是满的，然后一点点变少"，三个阶段的视觉语言也就统一了：
   * 环的长度 = 这一阶段还剩多少。专注 100→0，微休息 100→0，大休息 100→0，
   * 阶段之间只有颜色变化（蓝→绿→橙），不会出现"从 0 涨到满"的跳变。
   *
   * 早先这里是三种写法：专注用已过比例（从 0 涨）、大休息写死 100、
   * 微休息沿用专注总进度，三段行为互相矛盾，看着像界面坏了。
   */
  function drainPercent(endsAt, startedAt, now) {
    const total = endsAt - startedAt
    if (total <= 0) return 0
    const p = ((endsAt - now) / total) * 100
    return Math.max(0, Math.min(100, p))
  }

  /** 专注：从本轮开始点起算，100 → 0 */
  function focusPercent(now) {
    return drainPercent(s.focusEndsAt, s.startedAt, now)
  }

  /** 大休息：从专注结束点起算 */
  function restPercent(now) {
    return drainPercent(s.restEndsAt, s.focusEndsAt, now)
  }

  /** 微休息：从这一次微休息的排定起点起算（可能被专注结束点截短） */
  function microPercent(now) {
    return drainPercent(s.microEndsAt, s.nextMicroAt, now)
  }

  function snapshot(now, cfg) {
    const c = cfg || lastCfg || {}
    const st = {
      phase: s.phase,
      running: s.running,
      paused: !!s.pausedAt,
      rounds: s.rounds,
      gapSec: s.gapSec,
      microSec: s.microSec,
      // 当前阶段剩余
      remainMs: 0,
      // 距下一次微休息提示
      nextMicroInMs: 0,
      // 本轮专注总时长与已进行时长
      focusTotalMs: Math.max(0, s.focusEndsAt - s.startedAt),
      focusElapsedMs: 0,
      // 进度百分比 0-100
      percent: 0
    }

    if (s.phase === FOCUS) {
      st.remainMs = Math.max(0, s.focusEndsAt - now)
      st.nextMicroInMs = Math.max(0, s.nextMicroAt - now)
      st.focusElapsedMs = Math.min(st.focusTotalMs, Math.max(0, now - s.startedAt))
      // 满环 → 0：让用户一眼看出"还剩多少"，而不是"已经用掉多少"
      st.percent = focusPercent(now)
    } else if (s.phase === MICRO) {
      st.remainMs = Math.max(0, s.microEndsAt - now)
      st.nextMicroInMs = 0
      st.focusElapsedMs = Math.min(st.focusTotalMs, Math.max(0, now - s.startedAt))
      // 环显示这次微休息还剩多少，而不是"专注总进度"（那个在这十几秒里是不动的）
      st.percent = microPercent(now)
    } else if (s.phase === REST) {
      st.remainMs = Math.max(0, s.restEndsAt - now)
      st.nextMicroInMs = 0
      st.focusElapsedMs = st.focusTotalMs
      st.percent = restPercent(now)
    }

    // 暂停时展示暂停那一刻的读数
    if (s.pausedAt) {
      const at = s.pausedAt
      if (s.phase === FOCUS) {
        st.remainMs = Math.max(0, s.focusEndsAt - at)
        st.nextMicroInMs = Math.max(0, s.nextMicroAt - at)
        st.focusElapsedMs = Math.min(st.focusTotalMs, Math.max(0, at - s.startedAt))
        st.percent = focusPercent(at)
      } else if (s.phase === MICRO) {
        st.remainMs = Math.max(0, s.microEndsAt - at)
        st.percent = microPercent(at)
      } else if (s.phase === REST) {
        st.remainMs = Math.max(0, s.restEndsAt - at)
        // 暂停时环也要停在当时的位置，不能继续往后退
        st.percent = restPercent(at)
      }
    }

    return st
  }

  return {
    start,
    pause,
    resume,
    stop,
    tick,
    getState: (now) => snapshot(now || Date.now(), lastCfg),
    raw: () => s,
    hydrate: (obj) => {
      s = Object.assign(blank(), obj || {})
    }
  }
}

export function createEngine(saved) {
  return makeEngine(saved)
}

export default createEngine
