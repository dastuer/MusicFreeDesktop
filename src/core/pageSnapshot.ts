/**
 * 页面级数据快照（模块作用域，跨挂载存活）
 *
 * 主内容区按 `key={route.path + params}` 做整体重挂载（见 App.tsx），切页时上一页
 * 的组件实例连同全部 state 一起被丢掉。页面如果就此冷启动——`loading` 初值写死
 * true、列表初值空数组——挂载首帧只能画骨架屏，于是「内容 → 骨架屏 → 内容」在
 * 几百毫秒内发生两次无过渡的整屏替换，观感上就是切过去的瞬间页面闪了一下。
 *
 * 这里把「上一次真正展示过的数据」按 (页面, 音源) 留在模块作用域：重新挂载时先用
 * 它渲染首帧，真实请求在后台静默跑完再替换。只有首次进入该页面、或换了音源，才会
 * 看到骨架屏。
 *
 * 使用约定：
 *  - 只存能常驻内存的展示数据。**别把封面 base64 塞进来**（见 Cover / 封面缓存相关
 *    注释）：快照是常驻内存的，塞进去等于泄漏。封面统一用 `mfs://cover/<md5>.<ext>`
 *    短链。
 *  - 存/取都是引用传递，调用方不要就地修改取回来的对象。
 *  - 加载中与失败态不要写，否则会把上一次的好数据覆盖成半成品。
 */

/** 按 `页面@音源` 分开存：换音源等同于换一份数据，不能复用 */
const snapshots = new Map<string, unknown>();

function keyOf(page: string, sourceHash: string) {
    return `${page}@${sourceHash}`;
}

/**
 * 读取指定页面在指定音源下的快照。
 * 返回 null 表示没有可用快照（首次进入、换过音源），调用方按冷启动处理。
 */
export function readPageSnapshot<T>(page: string, sourceHash: string): T | null {
    return (snapshots.get(keyOf(page, sourceHash)) as T | undefined) ?? null;
}

/** 写入快照，供下一次挂载该页面时渲染首帧 */
export function writePageSnapshot<T>(page: string, sourceHash: string, data: T) {
    snapshots.set(keyOf(page, sourceHash), data);
}
