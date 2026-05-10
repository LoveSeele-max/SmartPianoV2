/**
 * sheetLibrary.js - 本地曲谱库模块
 * 使用 IndexedDB 实现本地曲谱持久化存储和播放列表管理
 */

const DB_NAME = 'PianoSheetDB';
const DB_VERSION = 1;
const STORE_NAME = 'sheets';

/** 打开 IndexedDB 数据库 */
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('name', 'name', { unique: false });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };

        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

/**
 * 保存曲谱到本地库
 * @param {Object} songData - 曲谱数据 { name, data, bpm }
 * @param {string} fileName - 原始文件名
 */
export async function saveToLibrary(songData, fileName) {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const record = {
        name: songData.name || fileName,
        data: songData.data,
        bpm: songData.bpm || 100,
        timestamp: Date.now(),
        fileName: fileName
    };

    return new Promise((resolve, reject) => {
        const request = store.add(record);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** 获取本地库中的所有曲谱列表 */
export async function getAllSheets() {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('timestamp');

    return new Promise((resolve, reject) => {
        const request = index.openCursor(null, 'prev'); // 按时间倒序
        const results = [];

        request.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                results.push(cursor.value);
                cursor.continue();
            } else {
                resolve(results);
            }
        };
        request.onerror = () => reject(request.error);
    });
}

/** 根据 ID 获取曲谱 */
export async function getSheetById(id) {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
        const request = store.get(id);
        request.onsuccess = () => resolve(request.value);
        request.onerror = () => reject(request.error);
    });
}

/** 从本地库中删除曲谱 */
export async function deleteFromLibrary(id) {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
        const request = store.delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/** 获取本地曲谱数量统计 */
export async function getLibraryStats() {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
        const countRequest = store.count();
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
    });
}
