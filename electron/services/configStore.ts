import fs from "fs";
import path from "path";

type Store = Record<string, any>;

/**
 * 主进程持久化存储：userData/data/store.json
 * 提供 key-value 存取，供设置、歌单、历史等使用
 */
class ConfigStore {
    private baseDir = "";
    private filePath = "";
    private store: Store = {};

    setup(baseDir: string) {
        this.baseDir = baseDir;
        this.filePath = path.join(baseDir, "store.json");
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }
        try {
            if (fs.existsSync(this.filePath)) {
                this.store = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
            }
        } catch {
            this.store = {};
        }
    }

    private flush() {
        fs.writeFileSync(this.filePath, JSON.stringify(this.store, null, 2), "utf-8");
    }

    get(key: string, defaultValue?: any) {
        if (key in this.store) {
            return this.store[key];
        }
        return defaultValue;
    }

    set(key: string, value: any) {
        this.store[key] = value;
        this.flush();
        return value;
    }

    remove(key: string) {
        delete this.store[key];
        this.flush();
    }

    getAll(): Store {
        return this.store;
    }
}

export default new ConfigStore();
