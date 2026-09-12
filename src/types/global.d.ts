declare global {
    interface Window {
        mfp: {
            invoke: (channel: string, ...args: any[]) => Promise<any>;
            onDownloadEvent: (callback: (data: any) => void) => void;
        };
    }
}

export {};
