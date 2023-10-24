import {cloneDeep, get, has, isArray, isObject, isString, uniq,} from 'lodash';
import {SC2DataInfo} from "./SC2DataInfoCache";
import {simulateMergeSC2DataInfoCache} from "./SimulateMerge";
import {
    imgWrapBase64Url,
    IndexDBLoader,
    LazyLoader,
    LocalLoader,
    LocalStorageLoader,
    ModZipReader,
    RemoteLoader
} from "./ModZipReader";
import {SC2DataManager} from "./SC2DataManager";
import {JsPreloader} from 'JsPreloader';
import {LogWrapper, ModLoadControllerCallback} from "./ModLoadController";
import {ReplacePatcher} from "./ReplacePatcher";
import {ModLoadFromSourceType, ModOrderContainer, ModOrderItem} from "./ModOrderContainer";
import {LRUCache} from 'lru-cache';
import JSZip from 'jszip';

export interface IModImgGetter {
    /**
     * @return Promise<string>   base64 img string
     */
    getBase64Image(): Promise<string>;
}

export const StaticModImgLruCache = new LRUCache<string, string>({
    max: 100,
    ttl: 1000 * 60 * 30,
    dispose: (value: string, key: string, reason: LRUCache.DisposeReason) => {
        console.log('ModImgLruCache dispose', [value], [reason]);
    },
    updateAgeOnGet: true,
    updateAgeOnHas: true,
});

export class ModImgGetterDefault implements IModImgGetter {
    constructor(
        public zip: ModZipReader,
        public imgPath: string,
        public logger: LogWrapper,
    ) {
    }

    // imgCache?: string;

    async getBase64Image() {
        const cache = StaticModImgLruCache.get(this.imgPath);
        if (cache) {
            return cache;
        }
        const imgFile = this.zip.zip.file(this.imgPath);
        if (imgFile) {
            const data = await imgFile.async('base64');
            const imgCache = imgWrapBase64Url(this.imgPath, data);
            StaticModImgLruCache.set(this.imgPath, imgCache);
            return imgCache;
        }
        console.error(`ModImgGetterDefault getBase64Image() imgFile not found: ${this.imgPath} in ${this.zip.modInfo?.name}`);
        this.logger.error(`ModImgGetterDefault getBase64Image() imgFile not found: ${this.imgPath} in ${this.zip.modInfo?.name}`);
        return Promise.reject(`ModImgGetterDefault getBase64Image() imgFile not found: ${this.imgPath} in ${this.zip.modInfo?.name}`);
    }

}

export interface ModImg {
    // base64
    // data: string;

    // () => Promise<base64 string>
    getter: IModImgGetter;
    path: string;
}

export interface ModBootJsonAddonPlugin {
    modName: string;
    addonName: string;
    modVersion: string;
    params?: any[] | { [key: string]: any };
}

export function checkModBootJsonAddonPlugin(v: any): v is ModBootJsonAddonPlugin {
    let c: boolean = isString(get(v, 'modName'))
        && isString(get(v, 'addonName'))
        && isString(get(v, 'modVersion'));
    if (c && has(v, 'params')) {
        c = c && (isArray(get(v, 'params')) || isObject(get(v, 'params')));
    }
    return c;
}

export interface DependenceInfo {
    modName: string;
    version: string;
}

export function checkDependenceInfo(v: any): v is DependenceInfo {
    return isString(get(v, 'modName'))
        && isString(get(v, 'version'));
}

export interface ModBootJson {
    name: string;
    version: string;
    styleFileList: string[];
    scriptFileList: string[];
    scriptFileList_preload?: string[];
    scriptFileList_earlyload?: string[];
    scriptFileList_inject_early?: string[];
    tweeFileList: string[];
    imgFileList: string[];
    replacePatchList?: string[];
    additionFile: string[];
    addonPlugin?: ModBootJsonAddonPlugin[];
    dependenceInfo?: DependenceInfo[];
}

export interface ModInfo {
    name: string;
    version: string;
    cache: SC2DataInfo;
    imgs: ModImg[];
    // origin path, replace path
    imgFileReplaceList: [string, string][];
    // file name, file content
    scriptFileList_preload: [string, string][];
    // file name, file content
    scriptFileList_earlyload: [string, string][];
    // file name, file content
    scriptFileList_inject_early: [string, string][];
    replacePatcher: ReplacePatcher[];
    bootJson: ModBootJson;
}

export enum ModDataLoadType {
    'Remote' = 'Remote',
    'Local' = 'Local',
    'LocalStorage' = 'LocalStorage',
    'IndexDB' = 'IndexDB',
}

// `modReadOrder`/`modReadCache` the read mod from zip file
// `modOrder`/`modCache` the mod filter by the `filterModCanLoad`
// `modLazyOrder`/`modLazyCache` the mod that Lazy load by a mod programming
// `modLazyWaiting` the mod that Lazy load by a mod programming but not load yet
export class ModLoader {
    logger: LogWrapper;

    constructor(
        public gSC2DataManager: SC2DataManager,
        public modLoadControllerCallback: ModLoadControllerCallback,
        public thisWin: Window,
    ) {
        this.logger = this.gSC2DataManager.getModUtils().getLogger();
    }

    private modReadCache: ModOrderContainer = new ModOrderContainer();
    private modCache: ModOrderContainer = new ModOrderContainer();
    private modLazyCache: ModOrderContainer = new ModOrderContainer();

    private modLazyOderRecord: ModZipReader[] = [];

    /**
     * O(2n)
     */
    getModCacheOneArray() {
        return this.modCache.get_One_Array();
    }

    /**
     O(n)
     */
    getModCacheArray() {
        return this.modCache.get_Array();
    }

    /**
     O(1)
     */
    getModCacheMap() {
        return this.modCache.get_One_Map();
    }

    /**
     * O(n+2log(n))
     */
    checkModCacheData() {
        return this.modCache.checkData();
    }

    /**
     O(n)
     */
    checkModCacheUniq() {
        return this.modCache.checkNameUniq();
    }

    /**
     O(1)
     */
    getModCacheByNameOne(modName: string) {
        return this.modCache.getByNameOne(modName);
    }

    getModReadCache() {
        return this.modReadCache;
    }

    checkModConflictList() {
        const ml = this.modCache.order.map(T => T.mod)
            .filter((T): T is ModInfo => !!T)
            .map(T => T.cache);
        return simulateMergeSC2DataInfoCache(this.gSC2DataManager.getSC2DataInfoAfterPatch(), ...ml).map((T, index) => {
            return {
                mod: ml[index],
                result: T,
            };
        });
    }

    private modIndexDBLoader?: IndexDBLoader;
    private modLocalStorageLoader?: LocalStorageLoader;
    private modLocalLoader?: LocalLoader;
    private modRemoteLoader?: RemoteLoader;
    private modLazyLoader?: LazyLoader;

    getModZip(modName: string) {
        const order = cloneDeep(this.loadOrder).reverse();
        const nn = this.modCache.getByNameOne(modName);
        if (!nn) {
            return undefined;
        }
        return nn.zip;
    }

    public getIndexDBLoader() {
        return this.modIndexDBLoader;
    }

    public getLocalStorageLoader() {
        return this.modLocalStorageLoader;
    }

    public getLocalLoader() {
        return this.modLocalLoader;
    }

    public getRemoteLoader() {
        return this.modRemoteLoader;
    }

    public getLazyLoader() {
        return this.modLazyLoader;
    }

    loadOrder: ModDataLoadType[] = [];

    private addModeReadZip(T: ModZipReader, from: ModLoadFromSourceType) {
        if (T.modInfo) {
            const overwrite = !this.modReadCache.getHasByName(T.modInfo.name);
            if (overwrite) {
                this.modReadCache.deleteAll(T.modInfo.name);
            }
            // // this is invalid
            this.gSC2DataManager.getDependenceChecker().checkFor(T.modInfo, [this.modReadCache]);
            this.modReadCache.pushBack(T, from);
            this.modReadCache.checkNameUniq();
        }
    }

    public async loadMod(loadOrder: ModDataLoadType[]): Promise<boolean> {
        this.loadOrder = loadOrder;
        let ok = false;
        for (const loadType of this.loadOrder) {
            switch (loadType) {
                case ModDataLoadType.Remote:
                    if (!this.modRemoteLoader) {
                        this.modRemoteLoader = new RemoteLoader(this.modLoadControllerCallback);
                    }
                    try {
                        ok = await this.modRemoteLoader.load() || ok;
                        this.modRemoteLoader.modList.forEach(T => this.addModeReadZip(T, ModLoadFromSourceType.Remote));
                    } catch (e: Error | any) {
                        console.error(e);
                        this.logger.error(`ModLoader loadMod() RemoteLoader load error: ${e?.message ? e.message : e}`);
                    }
                    break;
                case ModDataLoadType.Local:
                    if (!this.modLocalLoader) {
                        this.modLocalLoader = new LocalLoader(this.modLoadControllerCallback, this.thisWin);
                    }
                    try {
                        ok = await this.modLocalLoader.load() || ok;
                        this.modLocalLoader.modList.forEach(T => this.addModeReadZip(T, ModLoadFromSourceType.Local));
                    } catch (e: Error | any) {
                        console.error(e);
                        this.logger.error(`ModLoader loadMod() LocalLoader load error: ${e?.message ? e.message : e}`);
                    }
                    break;
                case ModDataLoadType.LocalStorage:
                    if (!this.modLocalStorageLoader) {
                        this.modLocalStorageLoader = new LocalStorageLoader(this.modLoadControllerCallback);
                    }
                    try {
                        ok = await this.modLocalStorageLoader.load() || ok;
                        this.modLocalStorageLoader.modList.forEach(T => this.addModeReadZip(T, ModLoadFromSourceType.LocalStorage));
                    } catch (e: Error | any) {
                        console.error(e);
                        this.logger.error(`ModLoader loadMod() LocalStorageLoader load error: ${e?.message ? e.message : e}`);
                    }
                    break;
                case ModDataLoadType.IndexDB:
                    if (!this.modIndexDBLoader) {
                        this.modIndexDBLoader = new IndexDBLoader(this.modLoadControllerCallback);
                    }
                    try {
                        ok = await this.modIndexDBLoader.load() || ok;
                        this.modIndexDBLoader.modList.forEach(T => this.addModeReadZip(T, ModLoadFromSourceType.IndexDB));
                    } catch (e: Error | any) {
                        console.error(e);
                        this.logger.error(`ModLoader loadMod() IndexDBLoader load error: ${e?.message ? e.message : e}`);
                    }
                    break;
                default:
                    console.error('ModLoader loadTranslateData() unknown loadType:', [loadType]);
                    this.logger.error(`ModLoader loadTranslateData() unknown loadType: [${loadType}]`);
            }
        }
        await this.initModInjectEarlyLoadInDomScript();
        await this.gSC2DataManager.getAddonPluginManager().triggerHook('afterInjectEarlyLoad');
        await this.triggerAfterModLoad();
        await this.gSC2DataManager.getAddonPluginManager().triggerHook('afterModLoad');
        if (!this.modCache.checkData()) {
            console.error('ModLoader loadMod() modCache.checkData() failed. Data consistency check failed.');
            this.logger.error(`ModLoader loadMod() modCache.checkData() failed. Data consistency check failed.`);
        }
        if (!this.modCache.checkNameUniq()) {
            console.error('ModLoader loadMod() modCache.checkNameUniq() failed. Data consistency check failed.');
            this.logger.error(`ModLoader loadMod() modCache.checkNameUniq() failed. Data consistency check failed.`);
        }
        await this.initModEarlyLoadScript();
        await this.gSC2DataManager.getAddonPluginManager().triggerHook('afterEarlyLoad');
        await this.registerMod2Addon();
        await this.gSC2DataManager.getAddonPluginManager().triggerHook('afterRegisterMod2Addon');
        return Promise.resolve(ok);
    }

    private async registerMod2Addon() {
        for (const mod of this.modCache.get_Array()) {
            const modZipReader = mod.zip;
            await this.gSC2DataManager.getAddonPluginManager().registerMod2Addon(mod.mod, modZipReader);
        }
    }

    protected async triggerAfterModLoad() {
        for (const mod of this.modCache.get_Array()) {
            const modInfo = mod.mod;
            const modZipReader = mod.zip;
            const bootJson = modInfo.bootJson;
            await this.modLoadControllerCallback.afterModLoad(bootJson, modZipReader.zip, modInfo);
        }
    }

    // call the `canLoadThisMod` to filter mod.
    protected async filterModCanLoad(modeC: ModOrderContainer) {
        const canLoadList: ModOrderContainer = new ModOrderContainer();
        for (const m of modeC.get_Array()) {
            const bootJ = m.mod.bootJson;
            const zip = m.zip;
            if (!await this.modLoadControllerCallback.canLoadThisMod(bootJ, zip.zip)) {
                console.warn(`ModLoader ====== ModZipReader filterModCanLoad() Mod [${m.name}] be banned.`);
                this.logger.warn(`ModLoader ====== ModZipReader filterModCanLoad() Mod [${m.name}] be banned.`);
            } else {
                canLoadList.pushBack(m.zip, m.from);
            }
        }
        return canLoadList;
    }

    public async lazyRegisterNewMod(modeZip: JSZip) {
        if (!this.modLazyLoader) {
            this.modLazyLoader = new LazyLoader(this.modLoadControllerCallback);
        }
        console.log('ModLoader ====== lazyRegisterNewMod() LazyLoader load start: ', [modeZip]);
        try {
            const m = await this.modLazyLoader.add(modeZip);
            if (m.modInfo) {
                this.modLazyCache.pushBack(m, ModLoadFromSourceType.SideLazy);
                console.log('ModLoader ====== lazyRegisterNewMod() LazyLoader load ok: ', [m]);
                return true;
            } else {
                console.error('ModLoader lazyRegisterNewMod() LazyLoader load error: modInfo not found', [m]);
                this.logger.error(`ModLoader lazyRegisterNewMod() LazyLoader load error: modInfo not found`);
            }
        } catch (e: Error | any) {
            console.error(e);
            this.logger.error(`ModLoader lazyRegisterNewMod() LazyLoader load error: ${e?.message ? e.message : e}`);
        }
        return false;
    }

    private async do_initModInjectEarlyLoadInDomScript(modName: string, mod: ModInfo) {
        for (const [name, content] of mod.scriptFileList_inject_early) {
            console.log('ModLoader ====== do_initModInjectEarlyLoadInDomScript() inject start: ', [modName], [name]);
            this.logger.log(`ModLoader ====== do_initModInjectEarlyLoadInDomScript() inject start: [${modName}] [${name}]`);
            await this.gSC2DataManager.getModLoadController().InjectEarlyLoad_start(modName, name);
            const script = this.thisWin.document.createElement('script');
            script.innerHTML = content;
            script.setAttribute('scriptName', (name));
            script.setAttribute('modName', (modName));
            script.setAttribute('stage', ('InjectEarlyLoad'));
            if (this.gSC2DataManager) {
                // insert before SC2 data rootNode
                this.gSC2DataManager?.rootNode.before(script);
            } else {
                // or insert to head
                console.warn('ModLoader ====== do_initModInjectEarlyLoadInDomScript() gSC2DataManager is undefined, insert to head');
                this.logger.warn(`ModLoader ====== do_initModInjectEarlyLoadInDomScript() gSC2DataManager is undefined, insert to head`);
                this.thisWin.document.head.appendChild(script);
            }
            console.log('ModLoader ====== do_initModInjectEarlyLoadInDomScript() inject end: ', [modName], [name]);
            this.logger.log(`ModLoader ====== do_initModInjectEarlyLoadInDomScript() inject end: [${modName}] [${name}]`);
            await this.gSC2DataManager.getModLoadController().InjectEarlyLoad_end(modName, name);
        }
    }

    private async initModInjectEarlyLoadInDomScript() {
        let toLoadModeList = this.modReadCache.clone();
        this.modCache = new ModOrderContainer();
        while (toLoadModeList.size > 0) {
            const nowMod = toLoadModeList.popFront();
            if (!nowMod) {
                // never go there
                console.error('ModLoader ====== initModInjectEarlyLoadInDomScript() (!nowMod). never go there.');
                this.logger.error(`ModLoader ====== initModInjectEarlyLoadInDomScript() (!nowMod). never go there.`);
                continue;
            }
            this.modCache.pushBack(nowMod.zip, nowMod.from);
            await this.do_initModInjectEarlyLoadInDomScript(nowMod.name, nowMod.mod);
            // check ban
            // the `canLoadThisMod` will be call in `filterModCanLoad`
            // a mod only can ban the mods that load after it.
            // any mod loaded cannot be banned, because it's `InjectEarlyLoad` already be injected and run.
            toLoadModeList = await this.filterModCanLoad(toLoadModeList);
        }
    }

    private async do_initModEarlyLoadScript(modName: string, mod: ModInfo) {
        for (const [name, content] of mod.scriptFileList_earlyload) {
            console.log('ModLoader ====== initModEarlyLoadScript() excute start: ', [modName], [name]);
            this.logger.log(`ModLoader ====== initModEarlyLoadScript() excute start: [${modName}] [${name}]`);
            await this.gSC2DataManager.getModLoadController().EarlyLoad_start(modName, name);
            try {
                // const R = await Function(`return ${content}`)();
                const R = await JsPreloader.JsRunner(
                    content,
                    name,
                    modName,
                    'EarlyLoadScript',
                    this.gSC2DataManager,
                    this.thisWin,
                    this.logger,
                );
                console.log('ModLoader ====== initModEarlyLoadScript() excute result: ', [modName], [name], R);
                this.logger.log(`ModLoader ====== initModEarlyLoadScript() excute result: [${modName}] [${name}] [${R}]`);
            } catch (e) {
                console.error('ModLoader ====== initModEarlyLoadScript() excute error: ', [modName], [name], e);
                this.logger.error(`ModLoader ====== initModEarlyLoadScript() excute error: [${modName}] [${name}] [${e}]`);
            }
            console.log('ModLoader ====== initModEarlyLoadScript() excute end: ', [modName], [name]);
            this.logger.log(`ModLoader ====== initModEarlyLoadScript() excute end: [${modName}] [${name}]`);
            await this.gSC2DataManager.getModLoadController().EarlyLoad_end(modName, name);
            this.logger.log(`ModLoader ========= version: [${this.gSC2DataManager.getModUtils().version}]`);
        }
    }

    private async initModEarlyLoadScript() {
        let loadEndModList = new ModOrderContainer();
        let toLoadModList = this.modCache.clone();
        while (toLoadModList.size > 0) {
            const modNow = toLoadModList.popFront()!;
            await this.do_initModEarlyLoadScript(modNow.name, modNow.mod);
            // to load lazy mod if this mod inject lazy mod
            // `tryInitWaitingLazyLoadMod` will change `modOrder` , so we receive the new list from it
            [toLoadModList, loadEndModList] = await this.tryInitWaitingLazyLoadMod(modNow, toLoadModList, loadEndModList);
            console.log('loadEndModList', loadEndModList.clone());
        }
        console.log('loadEndModList', loadEndModList.clone());
        if (!loadEndModList.checkNameUniq()) {
            // never go there
            console.error('ModLoader ====== initModEarlyLoadScript() loadEndModList.checkNameUniq() failed. Data consistency check failed.', [loadEndModList]);
            this.logger.error(`ModLoader ====== initModEarlyLoadScript() loadEndModList.checkNameUniq() failed. Data consistency check failed.`);
        }
        this.modCache = loadEndModList;
    }

    private async tryInitWaitingLazyLoadMod(
        nowMod: ModOrderItem,
        toLoadModList: ModOrderContainer,
        loadEndModList: ModOrderContainer,
    ): Promise<[ModOrderContainer, ModOrderContainer]> /* [toLoadModList, endLoadModList] */ {
        if (this.modLazyCache.size > 0) {
            // the nowMod added some Lazy mod. we need load the Lazy mod and it's add Lazy mod.
            //      when this progress, Lazy mod will overwrite the mod that loaded before.
            //      there some mod can be safe(allow) overwrite, and some will dangerous if overwrite (that maybe incorrect need warning author).

            await this.gSC2DataManager.getModLoadController().LazyLoad_start(nowMod.name);
            const checkCanSafeOverwriteMod = (mod: ModOrderItem) => {
                return nowMod.name === mod.name
                    || toLoadModList.getHasByName(mod.name)
                    // || this.modLazyCache.getHasByName(mod.name)  // this cannot detect
                    ;
            }
            const checkCannotSafeOverwriteMod = (mod: ModOrderItem) => {
                return loadEndModList.getHasByName(mod.name);
            }

            let replacedNowMod = false;
            let newNowMod = nowMod;

            // filter ban
            this.modLazyCache = await this.filterModCanLoad(this.modLazyCache);

            let nowLoadedMod: ModOrderContainer = new ModOrderContainer();

            // mod can call add lazy mod on this loop,
            // so we must process the case that overwrite itself.
            // the `canSafeOverwriteMod` is the mod that can overwrite,
            // because in some case , user can load same name mod again and again to do some magic to hidden info.
            while (this.modLazyCache.size > 0) {
                console.log('modLazyCache', this.modLazyCache.clone());
                console.log('nowLoadedMod', nowLoadedMod.clone());
                console.log('loadEndModList', loadEndModList.clone());
                // remember the loading mod info, then pop-front it
                const mod = this.modLazyCache.popFront()!;
                this.modLazyOderRecord.push(mod.zip);
                // warning overwrite, but user can in-place overwrite self
                if (checkCanSafeOverwriteMod(mod)) {
                    console.log('ModLoader ====== tryInitWaitingLazyLoadMod() mod overwrite safe already loaded:',
                        [nowMod.name, mod.name, toLoadModList]);
                    this.logger.log(`ModLoader ====== tryInitWaitingLazyLoadMod() mod overwrite safe already loaded: [${mod.name}]. when LazyLoad by [${nowMod.name}] . ` +
                        ' be carefully, this will case unexpected behavior .');
                    if (nowMod.name === mod.name) {
                        replacedNowMod = true;
                        newNowMod = mod;
                    }
                } else if (checkCannotSafeOverwriteMod(mod)) {
                    console.warn('ModLoader ====== tryInitWaitingLazyLoadMod() mod overwrite unsafe already loaded:',
                        [nowMod.name, mod.name, loadEndModList]);
                    this.logger.warn(`ModLoader ====== tryInitWaitingLazyLoadMod() mod overwrite unsafe already loaded: [${mod.name}]. when LazyLoad by [${nowMod.name}] . ` +
                        'are you sure you want overwrite the mod that was loaded ? this will case unexpected behavior !!!');
                }

                this.gSC2DataManager.getDependenceChecker().checkFor(mod.mod, [toLoadModList, nowLoadedMod]);

                // overwrite loaded mod
                // user can overwrite loaded mod, but this is unusual case
                if (loadEndModList.getHasByName(mod.name)) {
                    console.warn('ModLoader ====== tryInitWaitingLazyLoadMod() overwrite loaded mod:',
                        [nowMod.name, mod.name, loadEndModList, toLoadModList, nowLoadedMod]);
                    this.logger.warn(`ModLoader ====== tryInitWaitingLazyLoadMod() overwrite loaded mod: [${mod.name}]. when LazyLoad by [${nowMod.name}] . ` +
                        'are you sure you want overwrite a mod that was loaded ? ' +
                        'this is unusual case , will cause js conflict and memory incorrect , and will case unexpected behavior !!!');
                    loadEndModList.deleteAll(mod.name);
                }
                // replace pending mod
                // means, the later mod we will overwrite and load early
                if (toLoadModList.getHasByName(mod.name)) {
                    console.warn('ModLoader ====== tryInitWaitingLazyLoadMod() overwrite later mod:',
                        [nowMod.name, mod.name, loadEndModList, toLoadModList, nowLoadedMod]);
                    this.logger.warn(`ModLoader ====== tryInitWaitingLazyLoadMod() overwrite later mod: [${mod.name}]. when LazyLoad by [${nowMod.name}] . ` +
                        'are you sure you want overwrite and early load the mod that need later load ? ' +
                        'this is unusual case , will broken mod order system , and will case unexpected behavior !!!');
                    toLoadModList.deleteAll(mod.name);
                }
                // loop overwrite lazy mod in this loop
                // user can overwrite self in this loop multi time
                if (nowLoadedMod.getHasByName(mod.name)) {
                    console.log('ModLoader ====== tryInitWaitingLazyLoadMod() overwrite loaded lazy mod:',
                        [nowMod.name, mod.name, loadEndModList, toLoadModList, nowLoadedMod]);
                    this.logger.log(`ModLoader ====== tryInitWaitingLazyLoadMod() overwrite loaded lazy mod: [${mod.name}]. when LazyLoad by [${nowMod.name}] . ` +
                        'are you sure you want overwrite a mod that was loaded in lazy load ? ' +
                        'carefully use this feature, otherwise will case unexpected behavior !!!');
                    nowLoadedMod.deleteAll(mod.name);
                }
                nowLoadedMod.pushBack(mod.zip, ModLoadFromSourceType.SideLazy);

                await this.do_initModInjectEarlyLoadInDomScript(mod.name, mod.mod);
                await this.do_initModEarlyLoadScript(mod.name, mod.mod);
                // next
                // user add lazy mod in this loop will be added into the end of `modLazyWaiting`
                // and maybe add duplicate mod, there maybe case duplicate load, so we must filter it.
                // in this special case, the duplicate mod will be overwritten by the last one, but will early load in the first one order.
                this.modLazyCache = await this.filterModCanLoad(this.modLazyCache);
                console.log('nowLoadedMod', nowLoadedMod.clone());
                console.log('loadEndModList', loadEndModList.clone());
            }

            // now the this.modLazyCache empty

            // rebuild `modOrder` (loadEndModList)
            loadEndModList.pushBack(newNowMod.zip, newNowMod.from);
            for (const mm of nowLoadedMod.get_Array()) {
                if (mm.from !== ModLoadFromSourceType.SideLazy) {
                    // never go there
                    console.error('ModLoader ====== tryInitWaitingLazyLoadMod() (!mm.from). never go there.', [mm]);
                    this.logger.error(`ModLoader ====== tryInitWaitingLazyLoadMod() (!mm.from). never go there.`);
                }
                loadEndModList.pushBack(mm.zip, mm.from);
            }

            await this.gSC2DataManager.getModLoadController().LazyLoad_end(nowMod.name);

            return [toLoadModList, loadEndModList];
        }

        loadEndModList.pushBack(nowMod.zip, nowMod.from);
        return [toLoadModList, loadEndModList];
    }

}
