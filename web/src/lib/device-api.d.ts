// Сгенерировано из src/lib/device.ts (scripts/device-api.mjs) — не править руками.
// Мобильная часть MUSICH: только описание, сама реализация — в закрытом коде приложения для Android.
import type { Changes, ServerTrack } from './api';
export declare const savedServer: () => string;
export declare const saveServer: (url: string | null) => void;
export type LocalProfile = {
    name: string;
    email?: string;
    avatar?: string;
};
export declare function loadProfile(): LocalProfile | null;
export declare const saveProfile: (p: LocalProfile) => void;
export declare const clearProfile: () => void;
export declare const savedNode: () => string;
export declare const saveNode: (node: string) => void;
export declare function normalizeServer(raw: string): string;
export declare const savedDeviceId: () => string | null;
export declare const saveDeviceId: (id: string | null) => void;
export declare function hardwareId(): Promise<string | undefined>;
export declare function deviceName(): Promise<string>;
export interface LocalFile {
    file: string;
    uri?: string;
    at?: StoreAt;
    hash?: string;
    cover?: string;
    size: number;
}
export declare const localFiles: () => Record<string, LocalFile>;
export declare const isLocal: (id: string) => boolean;
export declare const localHash: (id: string) => string;
export declare const excluded: () => Set<string>;
export declare const pinned: () => Set<string>;
export declare function pin(ids: string[]): void;
export declare function warmUp(): Promise<void>;
export declare const localSrc: (id: string) => string | undefined;
export declare const localCover: (id: string) => string | undefined;
export declare function downloadTrack(t: ServerTrack, url: string, coverUrl: string | undefined, onProgress: (p: number) => void): Promise<void>;
export declare function shareTrack(id: string, fileName: string, text: string, remoteUrl?: string): Promise<boolean>;
export declare const hasImage: (key: string) => boolean;
export declare const localImage: (key: string) => string | undefined;
export declare function cacheImage(key: string, url: string): Promise<void>;
export declare function fetchTrackCover(id: string, url: string): Promise<boolean>;
export declare function verifyLocal(): Promise<{
    checked: number;
    broken: number;
}>;
export declare function removeLocal(id: string, onlyHere: boolean): Promise<void>;
export declare const usedBytes: () => number;
export interface OutboxItem {
    id: string;
    name: string;
    file: string;
    uri?: string;
    at?: StoreAt;
    cover?: string;
    size: number;
    title: string;
    artist: string;
    album: string;
    duration: number;
    addedAt: string;
}
export declare const outbox: () => OutboxItem[];
export declare const isPending: (id: string) => boolean;
export declare const looksLikeAudio: (name: string, mime?: string) => boolean;
export declare function addFileToOutbox(file: File): Promise<OutboxItem>;
export declare function addSharedToOutbox(absPath: string, name: string): Promise<OutboxItem>;
export declare function outboxFile(item: OutboxItem): Promise<File>;
export declare function settleOutbox(item: OutboxItem, t: ServerTrack): Promise<void>;
export declare function dropOutbox(id: string): Promise<void>;
export declare function onShare(fn: (files: {
    uri: string;
    name: string;
    mimeType: string;
}[]) => void): Promise<void>;
export declare function loadMirror(server: string): Promise<Changes | null>;
export declare function loadAnyMirror(): Promise<Changes | null>;
export declare const mirrorChanges: () => Changes;
export declare const mirrorTrack: (id: string) => ServerTrack | undefined;
export declare function moveMirror(server: string): Promise<void>;
export declare function resetMirror(server: string): Promise<void>;
export declare function mergeIntoMirror(server: string, ch: Changes): void;
export type StoreAt = 'app' | 'shared' | 'tree';
export type StoragePrefs = {
    folder: 'default' | 'custom';
    keep: boolean;
    tree?: {
        uri: string;
        name: string;
    };
};
export declare const storagePrefs: () => StoragePrefs;
export declare const saveStoragePrefs: (p: StoragePrefs) => void;
export declare const storageTarget: (p?: StoragePrefs) => StoreAt;
export declare const storageInfo: () => Promise<{
    path: string;
    app: string;
    canRead: boolean;
    free?: number;
    total?: number;
}>;
export declare const pickFolder: () => Promise<{
    uri?: string;
    name?: string;
}>;
export declare const requestRead: () => Promise<{
    granted: boolean;
} | {
    granted: boolean;
}>;
export declare const misplaced: () => number;
export declare function importKept(withServer: boolean): Promise<number>;
export declare function relocate(busy: (id: string) => boolean, onProgress?: (done: number, total: number) => void): Promise<number>;
export declare const queuedPlays: () => {
    trackId: string;
    at: string;
}[];
export declare const queuePlay: (trackId: string, at?: string) => void;
export declare const clearPlays: (n: number) => void;
export declare function remapPlays(map: Map<string, string>): void;
type LocalPlay = {
    trackId: string;
    playedAt: string;
    source?: string;
};
export declare function localPlays(): LocalPlay[];
export declare function addLocalPlay(p: LocalPlay): void;
export declare function mergePlays(server: LocalPlay[]): LocalPlay[];
export declare function canDownload(wifiOnly: boolean): Promise<boolean>;
export declare function onNetworkChange(fn: (connected: boolean) => void): void;
export declare function onWifi(): Promise<boolean>;
export declare function onBackButton(back: () => boolean): void;
export interface NowPlaying {
    title: string;
    artist: string;
    album: string;
    cover?: string;
    playing: boolean;
    duration: number;
    position: number;
}
export declare function setNowPlaying(n: NowPlaying | null): Promise<void>;
export declare function onMediaButtons(h: {
    play: () => void;
    pause: () => void;
    next: () => void;
    prev: () => void;
    seek: (s: number) => void;
}): Promise<void>;
export {};
