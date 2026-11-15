/**
 * 配置的默认值与持久化
 *
 * 默认值取自网页版（focusTime 90 / restTime 20 / 微休息 10 秒 / 新专注算法），
 * 只把微休息改成 5~15 秒区间，贴合"随机"的用法。
 */

import storage from '@system.storage'

const KEY = 'rc_cfg_v1'

// 配置结构版本。
//   2: 默认震动强度 2 → 3
//   3: 默认开启屏幕常亮（息屏后计时不可靠，常亮是第一层保险）
const CONFIG_VERSION = 3

export const DEFAULTS = {
  focusMin: 90,      // 专注时长（分钟）
  restMin: 20,       // 大休息时长（分钟）
  gapMin: 3,         // 最小间隔（分钟）
  gapMaxMin: 5,      // 最大间隔（分钟）
  microMinSec: 5,    // 微休息最短（秒）
  microMaxSec: 15,   // 微休息最长（秒）
  algorithm: 'focus',// 'focus' 新专注算法 | 'true' 真随机
  autoRest: true,    // 专注结束自动进入大休息
  keepScreenOn: true,// 屏幕常亮：表一息屏，应用进程可能被挂起，提示就发不出来
  buzzLevel: 3       // 1 轻 / 2 标准 / 3 重（间隔最紧）
}

/** 把任意输入收敛成合法配置 */
export function normalize(raw) {
  const c = Object.assign({}, DEFAULTS, raw || {})

  // 老配置迁移。raw 里没有 cfgVer 就说明是旧版存下来的。
  if (raw && (raw.cfgVer === undefined || Number(raw.cfgVer) < 3)) {
    // 旧默认强度是 2 档，还停在 2 档的自动提到 3 档（用户主动改过就不动）
    if (Number(raw.buzzLevel) === 2) c.buzzLevel = 3
    // 常亮在 1.0.5 之前默认是关的，老用户升级后必须给他打开，
    // 否则息屏照样挂起，改了等于没改。
    c.keepScreenOn = true
  }
  c.cfgVer = CONFIG_VERSION
  const num = (v, d, lo, hi) => {
    const n = Number(v)
    if (!isFinite(n)) return d
    return Math.min(hi, Math.max(lo, Math.round(n)))
  }
  c.focusMin = num(c.focusMin, 90, 5, 180)
  c.restMin = num(c.restMin, 20, 0, 60)
  c.gapMin = num(c.gapMin, 3, 1, 60)
  c.gapMaxMin = num(c.gapMaxMin, 5, 1, 60)
  if (c.gapMaxMin < c.gapMin) c.gapMaxMin = c.gapMin
  // 间隔不能吃掉整个专注时长
  if (c.gapMin > c.focusMin) c.gapMin = c.focusMin
  if (c.gapMaxMin > c.focusMin) c.gapMaxMin = c.focusMin
  c.microMinSec = num(c.microMinSec, 5, 3, 120)
  c.microMaxSec = num(c.microMaxSec, 15, 3, 120)
  if (c.microMaxSec < c.microMinSec) c.microMaxSec = c.microMinSec
  c.buzzLevel = num(c.buzzLevel, 3, 1, 3)
  c.algorithm = c.algorithm === 'true' ? 'true' : 'focus'
  c.autoRest = !!c.autoRest
  c.keepScreenOn = !!c.keepScreenOn
  return c
}

export function loadConfig(cb) {
  const done = (cfg) => cb && cb(normalize(cfg))
  try {
    storage.get({
      key: KEY,
      success(data) {
        // 不同版本返回结构有差异，两种都兜住
        const raw = data && typeof data === 'object' && 'data' in data ? data.data : data
        let cfg = null
        if (raw && typeof raw === 'string') {
          try { cfg = JSON.parse(raw) } catch (e) { cfg = null }
        } else if (raw && typeof raw === 'object') {
          cfg = raw
        }
        done(cfg)
      },
      fail() { done(null) }
    })
  } catch (e) {
    done(null)
  }
}

export function saveConfig(cfg, cb) {
  const c = normalize(cfg)
  try {
    storage.set({
      key: KEY,
      value: JSON.stringify(c),
      success() { cb && cb(c) },
      fail() { cb && cb(c) }
    })
  } catch (e) {
    cb && cb(c)
  }
}

export default DEFAULTS
