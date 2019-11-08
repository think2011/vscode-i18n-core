import * as vscode from 'vscode'
import * as path from 'path'
import { google, baidu, youdao } from 'translation.js'
import { get, set, omit } from 'lodash'
import * as YAML from 'yaml'
import * as fs from 'fs'
import Utils from '../Utils'
import Config from '../Config'
import Log from '../Log'

interface ILng {
  localepath: string
  filepath: string
  isDirectory: boolean
  originLng: string
  lng: string
}

export interface ITransData extends ILng {
  id: string
  keypath: string
  key: string
  text: any
}

export enum StructureType {
  DIR, // 结构是文件夹的模式
  FILE // 结构是语言文件的模式
}

const FILE_EXT = {
  YAML: '.yml',
  JSON: '.json'
}
const fileCache: any = {}

export class I18nItem {
  localepath: string
  structureType: StructureType
  fileExt = FILE_EXT.JSON

  constructor(localepath) {
    this.localepath = localepath
    this.setStructureType()
    this.setFileExt()
    this.watch()
  }

  private setStructureType() {
    const isDirectory = this.lngs.some(lngItem => lngItem.isDirectory)
    this.structureType = isDirectory ? StructureType.DIR : StructureType.FILE
  }

  private setFileExt() {
    const [lngInfo] = this.lngs

    if (!lngInfo.isDirectory) {
      const { ext } = path.parse(lngInfo.filepath)
      this.fileExt = ext
      return
    }

    const hasYaml = fs.readdirSync(lngInfo.filepath).some(filename => {
      return path.parse(filename).ext === FILE_EXT.YAML
    })

    this.fileExt = hasYaml ? FILE_EXT.YAML : FILE_EXT.JSON
  }

  private watch() {
    const watcher = vscode.workspace.createFileSystemWatcher(
      `${this.localepath}/**`
    )

    const updateFile = (type, { fsPath: filepath }) => {
      const { ext } = path.parse(filepath)
      if (![FILE_EXT.JSON, FILE_EXT.YAML].includes(ext)) {
        return
      }

      switch (type) {
        case 'del':
          Reflect.deleteProperty(fileCache, filepath)
          break

        case 'change':
        case 'create':
          fileCache[filepath] = this.readFile(filepath)
          break

        default:
        // do nothing..
      }
    }
    watcher.onDidChange(updateFile.bind(this, 'change'))
    watcher.onDidCreate(updateFile.bind(this, 'create'))
    watcher.onDidDelete(updateFile.bind(this, 'del'))
  }

  get lngs(): ILng[] {
    const { localepath } = this
    const files = fs
      .readdirSync(localepath)
      .map(
        (pathname: string): ILng => {
          const filepath = path.resolve(localepath, pathname)
          const isDirectory = fs.lstatSync(filepath).isDirectory()
          const originLng = isDirectory ? pathname : path.parse(pathname).name

          return {
            localepath,
            filepath,
            isDirectory,
            originLng,
            lng: Utils.normalizeLng(originLng)
          }
        }
      )
      .filter(lngItem => !!lngItem.lng)
      .sort(lngItem => {
        return lngItem.lng === Config.sourceLocale ? -1 : 1
      })

    if (!files.length) {
      Log.error(`未能识别locale目录:${localepath}`)
    }

    return files
  }

  dataParse(filepath: string, data: any) {
    const { ext } = path.parse(filepath)
    return ext === FILE_EXT.JSON ? JSON.parse(data) : YAML.parse(data)
  }

  dataStringify(filepath: string, data: any) {
    const { ext } = path.parse(filepath)
    return ext === FILE_EXT.JSON
      ? JSON.stringify(data, null, 2)
      : YAML.stringify(data)
  }

  readFile(filepath: string, useCache: boolean = false): any {
    // TODO: LRU缓存优化
    if (useCache) {
      return fileCache[filepath] || this.readFile(filepath)
    }

    try {
      let fileData = fs.readFileSync(filepath)
      if (fileData[0] === 0xEF && fileData[1] === 0xBB && fileData[2] === 0xBF) {
        fileData = fileData.slice(3)
      }
      const data = this.dataParse(filepath, fileData.toString('utf-8'))

      fileCache[filepath] = data
      return typeof data === 'object' ? data : {}
    } catch (err) {
      return {}
    }
  }

  async transByApi({
    text,
    from = Config.sourceLocale,
    to
  }: {
    text: string
    from?: string
    to: string
  }) {
    const plans = [google, baidu, youdao]
    const errors: Error[] = []

    let res = undefined
    for (const plan of plans) {
      try {
        res = await plan.translate({ text, from, to })
        break
      } catch (e) {
        errors.push(e)
      }
    }

    const result = res && res.result && res.result[0]
    if (!result) throw errors

    return result
  }

  async overrideCheck(keypath): Promise<boolean> {
    let [{ text }] = this.getI18n(keypath)
    // 检测尾 key
    let overrideKey = text ? keypath : undefined

    if (!overrideKey) {
      let tempKeypath = keypath.split('.')

      // 向前检测 key
      while (tempKeypath.length) {
        tempKeypath.pop()

        const tempOverrideKey = tempKeypath.join('.')
        const [{ text: tempText }] = this.getI18n(tempOverrideKey)

        if (
          typeof tempText === 'object' ||
          typeof tempText === 'undefined' ||
          tempText === 'undefined'
        ) {
          continue
        } else {
          overrideKey = tempOverrideKey
          text = tempText
          break
        }
      }
    }

    if (!overrideKey) {
      return true
    }

    const overrideText = '覆盖'
    const isOverride = await vscode.window.showInformationMessage(
      `已有 ${overrideKey} 👉 ${text}, 覆盖吗？`,
      { modal: true },
      overrideText
    )

    return isOverride === overrideText
  }

  transI18n(transData: ITransData[]): Promise<ITransData[]> {
    const mainTrans = transData.find(item => item.lng === Config.sourceLocale)

    const tasks = transData.map(async transItem => {
      if (transItem === mainTrans) {
        return transItem
      }

      transItem.text =
        (await this.transByApi({
          text: mainTrans.text,
          from: Config.sourceLocale,
          to: transItem.lng
        })) || transItem.text

      return transItem
    })

    return Promise.all(tasks)
  }

  removeI18n(key: string) {
    const transData = this.getI18n(key)

    transData.forEach(({ filepath, keypath }) => {
      const file = fileCache[filepath]
      fs.writeFileSync(
        filepath,
        this.dataStringify(filepath, omit(file, keypath))
      )
    })
  }

  getI18n(key: string): ITransData[] {
    return this.lngs.map(lngItem => {
      let i18nFilepath = lngItem.filepath
      let keypath = key

      if (this.structureType === StructureType.DIR) {
        const [filename, ...realpath] = key.split('.')

        i18nFilepath = path.join(i18nFilepath, `${filename}${this.fileExt}`)
        keypath = realpath.join('.')
      }

      // 读取文件
      const file = this.readFile(i18nFilepath, true)

      return {
        ...lngItem,
        id: Math.random()
          .toString(36)
          .substr(-6),
        key,
        keypath,
        filepath: i18nFilepath,
        text: keypath ? get(file, keypath) : file
      }
    })
  }

  async writeI18n(transData: ITransData[]): Promise<any> {
    const writePromise = transData.map(({ filepath, keypath, text }) => {
      return new Promise((resolve, reject) => {
        const file = this.readFile(filepath, true)

        set(file, keypath, text)
        fs.writeFile(filepath, this.dataStringify(filepath, file), err => {
          if (err) {
            return reject(err)
          }

          resolve()
        })
      })
    })

    return Promise.all(writePromise)
  }
}
