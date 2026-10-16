# Jiten Request Enhancer

This userscript improves the request form at [jiten.moe/requests/new](https://jiten.moe/requests/new).

- **Paste a URL to fill the title.** Paste a database link into **External URL** and the script fetches the entry. It fills **Title** with the Japanese title, or with the main title when there is no Japanese one, replacing whatever was there.
- **Media type picked for you.** If you haven't chosen a **Media Type** yet, the script picks it from the link: anime, manga, novel, visual novel or web novel. If you paste a different link, the type it picked follows the new link. It never changes a type you chose yourself.
- **Search from the title field.** Pick a **Media Type**, then type into **Title**. A dropdown lists matches from the sites Jiten uses for that type. Click a match, or move with ↑/↓ and press Enter, to fill both Title and External URL. This works even when External URL already has a link.
  Each result shows its format, episode or volume count, studio, author or developer, and year.
- **Links in the title field.** A link pasted into **Title** is moved to **External URL** and looked up.

Clearing the link also clears a title the script filled, unless you've edited it since. A media type the script picked is cleared too.

When **This is an update to an existing media** is ticked, the script does nothing.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/), [Tampermonkey](https://www.tampermonkey.net/) or [Greasemonkey](https://www.greasespot.net/).
2. Open [`jiten-request-enhancer.user.js`](https://raw.githubusercontent.com/nerenar/jiten-request-enhancer/main/jiten-request-enhancer.user.js) and confirm the install.

## Sources

The script only calls public APIs that need no key. It never reads site pages directly.

| Media type | Search order |
|---|---|
| Anime, Manga | AniList, then MyAnimeList |
| Novel | AniList (novels), then MyAnimeList (light novels) |
| Visual Novel | VNDB |
| Web Novel | Syosetu |

Other media types get no search. Music videos and promotional clips are left out of anime search.

Pasting a URL fills the title for these URL shapes:

| Site | Supported URL |
|---|---|
| VNDB | `vndb.org/v…` |
| AniList | `anilist.co/anime/…`, `anilist.co/manga/…` |
| MyAnimeList | `myanimelist.net/anime/…`, `myanimelist.net/manga/…` |
| Syosetu | `ncode.syosetu.com/n…`, `novel18.syosetu.com/n…` |

In search, MyAnimeList only shows entries AniList doesn't have. A MyAnimeList hit that AniList does have is shown under AniList instead.

## Settings

Open the userscript manager menu and choose **Jiten Request Enhancer settings**.

- **Search while typing:** on by default. Turn it off to stop the search dropdown under Title. Pasted links are still looked up.
- **Show adult covers:** off by default. Covers of adult entries (AniList adult, MyAnimeList Rx/hentai, VNDB explicit) stay blank unless this is on.

If a site starts refusing requests because there have been too many, the script waits and retries once. After that, it shows how long until that site can be searched again.

## License

[MIT](LICENSE)
