/**
 * 随机间隔算法 —— 移植自 zeenzeen.com/random-reminder
 *
 * 原版（minified 源码）有两套机制：
 *
 * 1. 真随机：在 [min, max] 秒内均匀取值
 *    Math.floor(Math.random() * (max - min + 1)) + min
 *
 * 2. 新专注算法：仅当「专注时长 >= 40 分钟」且「区间跨度 >= 120 秒」时生效，
 *    否则退回真随机。生效后按当前专注进度分段：
 *      - 前 21 分钟（elapsed <= 1260s）：均匀随机
 *      - 最后 15%（elapsed >= 0.85 * focusSec）：均匀随机
 *      - 中间时段： min + pow(n, 0.1) * (max - min)
 *        pow(n, 0.1) 会把 [0,1) 的均匀分布压向 1，取整后结果集中在区间上沿，
 *        也就是「越往后越容易抽到长间隔」，避免提醒过于密集。
 *
 * 移植时保持这三个分支的边界与原版一致，只把单位统一成秒。
 */

/** 闭区间随机整数 [min, max] */
export function randInt(min, max) {
  const a = Math.round(min)
  const b = Math.round(max)
  if (b <= a) return a
  return Math.floor(Math.random() * (b - a + 1)) + a
}

/**
 * 抽一个间隔
 * @param {Object} o
 * @param {string} o.algorithm  'focus' 新专注算法 | 'true' 真随机
 * @param {number} o.gapSec     最小间隔（秒）
 * @param {number} o.gapMaxSec  最大间隔（秒）
 * @param {number} o.elapsedSec 当前专注已进行秒数
 * @param {number} o.focusSec   本轮专注总秒数
 * @returns {number} 间隔秒数
 */
export function pickGap(o) {
  const min = Math.max(5, Math.round(o.gapSec))
  const max = Math.max(min, Math.round(o.gapMaxSec))
  const focusSec = Math.max(0, Math.round(o.focusSec))
  const elapsedSec = Math.max(0, Math.round(o.elapsedSec))

  // 真随机，或新专注算法的前提不成立
  if (o.algorithm !== 'focus') return randInt(min, max)
  if (focusSec < 2400 || max - min < 120) return randInt(min, max)

  // 开头 21 分钟照常随机
  if (elapsedSec <= 1260) return randInt(min, max)
  // 收尾 15% 照常随机
  if (elapsedSec >= focusSec * 0.85) return randInt(min, max)

  // 中段：向区间上沿偏斜（与原版 pow(n, 0.1) 一致）
  const n = Math.random()
  return Math.floor(min + Math.pow(n, 0.1) * (max - min))
}
