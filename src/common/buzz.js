/**
 * 震动编码
 *
 * Redmi Watch 6 只支持 vibrator.vibrate({mode:'long'|'short'})：
 *   start / stop / getSystemDefaultMode 在这个型号上都不支持。
 * 没有强度参数，long 就是它能给出的最大力度；也做不出精确毫秒波形，
 * 只能用 long 的序列 + setTimeout 拼节奏。
 *
 * ---------------------------------------------------------------
 * 编码规则：一律「两下一组的长震」，用**几组**区分事件。
 *
 *   该休息（微休息开始）  1 组  ●●                咚咚
 *   继续工作（微休息结束）2 组  ●● — ●●           咚咚 咚咚
 *   专注结束              3 组  ●● — ●● — ●●      咚咚 咚咚 咚咚
 *   大休息结束            4 组  ●● — ●● — ●● — ●● 四组，最长
 *
 * 为什么不用「一下长震」表示继续工作：
 * 单次 long 只是一个约 0.4 秒的孤脉冲，戴在手腕上经常被当成通知提醒忽略掉——
 * 用户反馈几乎无感。震两下、而且成组，手腕上是两段明确的压感，跑不掉。
 *
 * 为什么用「组」而不是单纯加下数：
 * 单纯数下数，2/3/4/5 下很容易数错；成对分组以后只要数「几组咕咚」，
 * 组与组之间留 420ms 的明显停顿，耳朵没有，手上也能分出节奏。
 *
 * 强度三档只动间隔，不动下数：
 *   轻 = 所有间隔 ×1.7（松散，像几下轻点）
 *   重 = 所有间隔 ×0.7，但下限 120ms
 * 120ms 是下限，因为两下挨得比这更近会被系统合并成一次，
 * 反而变成一个长震——那不是变强，是变弱。
 */

import vibrator from '@system.vibrator'

/** 组内间隔 / 组间停顿（标准档） */
const INNER = 170
const BETWEEN = 420

/** 生成 groups 组「两下长震」。gaps[k] 表示第 k 下之后的间隔，长度正好是 modes 少一。 */
function groups(n) {
  const modes = []
  const gaps = []
  for (let g = 0; g < n; g++) {
    if (g > 0) gaps.push(BETWEEN) // 组间停顿，接在上一组最后一下之后
    modes.push('long')
    gaps.push(INNER)
    modes.push('long')
  }
  return { modes, gaps }
}

const PATTERNS = {
  microStart: groups(1),
  microEnd: groups(2),
  focusEnd: groups(3),
  restEnd: groups(4),
  test: groups(1)
}

let pendingTimer = null
let seq = 0

/** 取消正在播放的节奏（页面销毁、手动停止时调用，避免定时器泄漏） */
export function cancelBuzz() {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  seq += 1
}

/**
 * 播放一个震动节奏
 * @param {string} name 节奏名
 * @param {number} level 1 轻（间隔松）/ 2 标准 / 3 重（间隔紧）
 */
export function buzz(name, level) {
  const p = PATTERNS[name]
  if (!p) return

  cancelBuzz()

  const modes = p.modes
  const lv = level || 3
  const f = lv >= 3 ? 0.7 : (lv <= 1 ? 1.7 : 1)
  const gaps = p.gaps.map((g) => Math.max(120, Math.round(g * f)))

  const mySeq = seq
  let i = 0
  const step = () => {
    pendingTimer = null
    // 已经被新的节奏接管，别再往下震
    if (mySeq !== seq) return
    if (i >= modes.length) return
    try {
      vibrator.vibrate({ mode: modes[i] })
    } catch (e) {
      console.error('vibrate fail', e)
    }
    i += 1
    if (i < modes.length) pendingTimer = setTimeout(step, gaps[i - 1])
  }
  step()
}

/** 判断某个事件该不该震：lag 太大的（睡过头了）不震，避免恢复瞬间连震一串 */
export function shouldBuzz(event, staleMs) {
  const limit = staleMs || 4000
  return event && event.lag >= 0 && event.lag <= limit
}

export const EVENT_PATTERN = {
  microStart: 'microStart',
  microEnd: 'microEnd',
  focusEnd: 'focusEnd',
  restEnd: 'restEnd'
}

export default buzz
