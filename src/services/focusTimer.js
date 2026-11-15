/**
 * 专注计时微服务
 *
 * 为什么要做成微服务：快应用的页面切到后台/息屏后可能被挂起，
 * 普通页面里的 setInterval 不保证继续跑。而微服务是"脱离应用生命周期、
 * 可以后台运行的服务"（见官方「微服务」文档），页面关了它还在。
 * 服务端可用接口表里明确包含 system.vibrator: all，所以震动也能在这里发。
 *
 * 边界：
 *   - 服务只负责计时 + 震动 + 广播状态，不做 UI。
 *   - 页面通过 serviceclient.connect({policy:'always'}) 连上来，发命令、收快照。
 *   - 若本机型不支持微服务，页面会退回"本地计时"，见 pages/Home/index.ux。
 */

import engineFactory from '../common/engine'
import { buzz, shouldBuzz, EVENT_PATTERN } from '../common/buzz'
import DEFAULTS, { normalize } from '../common/config'
import storage from '@system.storage'

const STATE_KEY = 'rc_state_v1'
const TICK_MS = 500
const SAVE_EVERY_MS = 15000
// 相邻两次 tick 间隔超过这个值，就认为进程被系统挂起过（正常是 500ms）
const SUSPEND_MS = 4000
// 挂起超过这么久就不补震了：几十秒前甚至几小时前的"该休息"再震一次没有意义
const MAKEUP_WINDOW_MS = 10 * 60000

let engine = null
let cfg = normalize(DEFAULTS)
let timer = null
let clients = []
let lastSaveAt = 0
let lastTickAt = 0

function broadcast(params) {
  try {
    serviceManager.postMessage({ clientId: 0, params })
  } catch (e) {
    console.error('postMessage fail', e)
  }
}

function snapshot() {
  return engine ? engine.getState() : null
}

function pushState() {
  const st = snapshot()
  if (st) broadcast({ type: 'state', state: st })
}

function persist(force) {
  const now = Date.now()
  if (!force && now - lastSaveAt < SAVE_EVERY_MS) return
  lastSaveAt = now
  try {
    // 状态和配置一起存：否则服务被系统回收重启后，会拿默认 90/20 去续跑
    // 一个属于别的配置的会话，排期全乱。
    storage.set({
      key: STATE_KEY,
      value: JSON.stringify({ s: engine.raw(), c: cfg }),
      success() {},
      fail() {}
    })
  } catch (e) {}
}

function handleEvents(events) {
  if (!events || !events.length) return
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    // 睡过头的事件不震，否则恢复瞬间会连震一串
    if (shouldBuzz(ev, 4000)) {
      const pattern = EVENT_PATTERN[ev.type]
      if (pattern) buzz(pattern, cfg.buzzLevel)
      broadcast({ type: 'event', name: ev.type })
    }
  }
  persist(true)
}

function loop() {
  if (!engine) return
  const now = Date.now()

  // 上次 tick 到现在实际过了多久。挂起期间这个间隔会远大于 500ms。
  const sleptMs = lastTickAt ? now - lastTickAt : 0
  lastTickAt = now

  const r = engine.tick(now, cfg)

  if (sleptMs > SUSPEND_MS) {
    // 被系统挂起过（息屏、切后台、低电省电）。
    // 这期间的提示是发不出来的，回来后补发一次，并告诉界面发生了什么。
    onWake(sleptMs, r.events)
  } else if (r.events && r.events.length) {
    handleEvents(r.events)
  }

  // 空闲时不广播也不写盘，避免 autoStart 的服务在没人用时白耗电
  if (r.state.running || r.state.phase !== 'idle') {
    pushState()
    persist(false)
  }
}

/**
 * 从挂起中恢复。
 *
 * 逐个补震会连震一串（一次挂起可能攒了好几个事件），所以只补**最有用的那一个**：
 * 微休息开始（该休息了）优先，其次大休息结束（该回去干活了）。
 * 其余事件只记账、不震，界面会收到 woke 消息自己提示。
 */
function onWake(sleptMs, events) {
  const evs = events || []
  let makeUp = ''
  for (let i = 0; i < evs.length; i++) {
    if (evs[i].type === 'microStart') makeUp = 'microStart'
    else if (evs[i].type === 'restEnd' && !makeUp) makeUp = 'restEnd'
  }

  let buzzed = ''
  if (makeUp && sleptMs <= MAKEUP_WINDOW_MS) {
    buzz(makeUp, cfg.buzzLevel)
    buzzed = makeUp
    broadcast({ type: 'event', name: makeUp, late: true })
  }

  console.info('wake from suspend', sleptMs, 'events', evs.length, 'makeup', buzzed)
  broadcast({ type: 'woke', sleptMs, missed: evs.length, buzzed })
  persist(true)
}

function startTimer() {
  if (timer) clearInterval(timer)
  lastTickAt = Date.now()
  timer = setInterval(loop, TICK_MS)
}

export default {
  onCreate(params) {
    console.info('focus-timer onCreate', params)
    engine = engineFactory(null)

    // 恢复上次状态：服务被系统回收后重开，能接着算
    try {
      storage.get({
        key: STATE_KEY,
        success(data) {
          const raw = data && typeof data === 'object' && 'data' in data ? data.data : data
          if (raw && typeof raw === 'string') {
            try {
              const obj = JSON.parse(raw)
              // 新格式 {s, c}；裸 state 的旧格式也兜一下
              if (obj && obj.s) {
                engine.hydrate(obj.s)
                if (obj.c) cfg = normalize(obj.c)
              } else if (obj && obj.phase) {
                engine.hydrate(obj)
              }
            } catch (e) {}
          }
          startTimer()
        },
        fail() { startTimer() }
      })
    } catch (e) {
      startTimer()
    }
  },

  onConnect(clientId, params) {
    if (clients.indexOf(clientId) < 0) clients.push(clientId)
    // 连上就把当前状态和配置推过去，页面不用再问
    try {
      serviceManager.postMessage({
        clientId,
        params: { type: 'hello', state: snapshot(), config: cfg }
      })
    } catch (e) {}
  },

  onDisConnect(clientId) {
    const i = clients.indexOf(clientId)
    if (i >= 0) clients.splice(i, 1)
  },

  onDestroy() {
    if (timer) clearInterval(timer)
    timer = null
    persist(true)
  },

  onMessage(clientId, params) {
    const cmd = params && params.cmd
    const now = Date.now()

    if (cmd === 'hello') {
      serviceManager.postMessage({
        clientId,
        params: { type: 'hello', state: snapshot(), config: cfg }
      })
      return
    }

    if (cmd === 'start') {
      if (params.config) cfg = normalize(params.config)
      engine.start(now, cfg)
      persist(true)
      pushState()
      broadcast({ type: 'started' })
      return
    }

    if (cmd === 'pause') {
      engine.pause(now)
      persist(true)
      pushState()
      return
    }

    if (cmd === 'resume') {
      engine.resume(now)
      persist(true)
      pushState()
      return
    }

    if (cmd === 'stop') {
      engine.stop(now)
      persist(true)
      pushState()
      return
    }

    if (cmd === 'config') {
      cfg = normalize(params.config)
      persist(true)
      broadcast({ type: 'config', config: cfg })
      pushState()
      return
    }

    if (cmd === 'test') {
      const pattern = (params && params.pattern) || 'microStart'
      buzz(pattern, cfg.buzzLevel)
      return
    }
  }
}
