import { getPluginByMedia, getSortedSearchablePlugins, pluginCall } from "@/core/ipc";
import { getSearchSource } from "@/core/mediaSource";
import { navigate } from "@/core/router";
import { showToast } from "@/components/base/Toast";

/**
 * 「查看歌手」：从只有歌手名字符串的条目（歌曲行 / 播放详情）跳到歌手详情页。
 *
 * 歌手详情页的 getArtistWorks 需要**带 id 的 artistItem**，而歌曲条目上只有个名字——
 * 先用提供这首歌的音源把歌手搜出来（取第一个命中），拿着结果跳转。
 * 多人合唱（"A/B"、"A feat. B"）取第一段：按整串搜基本搜不到，宁可先给主唱。
 *
 * 本地文件（platform「本地音乐」对不上插件）退回「当前音源」：
 * 搜索页记住的音源优先（用户最近在用的），其次默认音源——
 * 这样从本地列表点歌手，落到的是自己正在用的那个音源的歌手音乐列表。
 *
 * @returns 是否发起了跳转（调用方据此决定要不要收起浮层）
 */
export async function navigateToArtist(musicItem: IMusic.IMusicItem): Promise<boolean> {
    const rawName = (musicItem.artist ?? "").trim();
    const name = rawName.split(/[\/、,，&]|feat\.?/i)[0].trim();
    if (!name) {
        showToast("这首歌没有歌手信息");
        return false;
    }
    // 先认提供这首歌的音源
    const provided = await getPluginByMedia(musicItem);
    const plugin =
        provided ??
        (await (async () => {
            const searchable = await getSortedSearchablePlugins();
            const remembered = getSearchSource();
            return (
                (remembered ? searchable.find((p) => p.hash === remembered) : undefined) ??
                searchable[0]
            );
        })());
    if (!plugin?.supportedMethods.includes("search")) {
        showToast("没有可用的搜索音源，请先在「音源」页安装并启用插件");
        return false;
    }
    try {
        const result = await pluginCall(plugin.hash, "search", name, 1, "artist");
        const artist = (result?.data ?? [])[0] as IArtist.IArtistItemBase | undefined;
        if (!artist) {
            showToast(`没有找到歌手「${name}」`);
            return false;
        }
        navigate("artistDetail", { artistItem: artist });
        return true;
    } catch (e: any) {
        showToast(`查找歌手失败：${e?.message ?? e}`);
        return false;
    }
}
