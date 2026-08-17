<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue'
import { recognizeImage, subscribeOcrProgress } from './services/ocr'
import { matchOperatorName } from './utils/similarity'
import { recognizeOperatorSkills } from './services/skillRecognition'
import type { SkillRecognitionResult } from './types/skill'

interface OperatorSkill {
  name: string
  icon: string
  skillId?: string
}

interface Operator {
  name: string
  profession: string
  rarity: number
  avatar_url?: string
  skills: OperatorSkill[]
}

// data/operators.json 的原始格式
interface RawOperatorData {
  characterId: string
  name: string
  profession: string
  rarity: number | null
  isNotObtainable: boolean
  appellation: string | null
  skills: Array<{
    skillId: string
    name: string
    icon: string
    iconKey: string
    hash: string
    colorFeature: [number, number, number]
  }>
}

const RARITIES = ['1星', '2星', '3星', '4星', '5星', '6星'] as const
const PROFESSIONS = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种'] as const

const allOperators = ref<Record<string, Operator[]>>({})
const loading = ref(true)
const loadError = ref('')
const recognizing = ref(false)
const ocrProgress = reactive<{ stage: string; percent: number }>({ stage: '', percent: 0 })
const recognizingElapsed = ref(0)
const ocrUsed = ref(false)
let recognizeTimer: ReturnType<typeof setInterval> | null = null
let currentNotification: HTMLElement | null = null
const pasteTarget = ref<HTMLTextAreaElement>()
const fileInput = ref<HTMLInputElement>()
const skillDisplayMode = ref<0 | 1>(0)
const skillResult = ref<SkillRecognitionResult | null>(null)

const selectedStars = reactive(new Set<string>(JSON.parse(localStorage.getItem('operatorFilter_stars') || '[]')))
const selectedClasses = reactive(new Set<string>(JSON.parse(localStorage.getItem('operatorFilter_classes') || '[]')))
const selectedOperators = reactive(new Set<string>())
const selectedSkills = reactive(new Set<string>())
const ocrPriority = ref<string[]>([])
const e1Mode = ref(localStorage.getItem('operatorFilter_e1Mode') === 'true')
const lowGapOperators = reactive(new Set<string>())

watch(e1Mode, (val) => {
  localStorage.setItem('operatorFilter_e1Mode', String(val))
  if (val) {
    const toSwitch: string[] = []
    selectedSkills.forEach(skillKey => {
      const [opName, skillName] = skillKey.split('::')
      const op = findOperatorByName(opName)
      if (op) {
        const visibleSkills = getVisibleSkills(op)
        if (!visibleSkills.includes(skillName) && visibleSkills.length >= 2) {
          toSwitch.push(opName)
        }
      }
    })
    toSwitch.forEach(opName => {
      const op = findOperatorByName(opName)
      if (op) {
        selectedSkills.delete(opName + '::' + op.skills[2])
        selectedSkills.add(opName + '::' + op.skills[1])
      }
    })
  }
})

function getVisibleSkills(op: Operator): OperatorSkill[] {
  return e1Mode.value ? op.skills.slice(0, 2) : op.skills
}

const totalCount = computed(() => {
  let count = 0
  RARITIES.forEach(r => {
    const ops = allOperators.value[r]
    if (ops) count += ops.length
  })
  return count
})

const displayCount = computed(() => {
  let count = 0
  RARITIES.forEach(r => {
    const ops = allOperators.value[r]
    if (!ops) return
    const starMatch = selectedStars.size === 0 || selectedStars.has(r)
    if (!starMatch) return
    ops.forEach(op => {
      const classMatch = selectedClasses.size === 0 || selectedClasses.has(op.profession)
      if (classMatch) count++
    })
  })
  return count
})

const selectedInfo = computed(() => {
  if (selectedOperators.size > 0) return `已选 ${selectedOperators.size} 干员`
  return ''
})

const filteredOperators = computed(() => {
  const result: { rarity: string; op: Operator }[] = []
  RARITIES.forEach(r => {
    const ops = allOperators.value[r]
    if (!ops) return
    const starMatch = selectedStars.size === 0 || selectedStars.has(r)
    if (!starMatch) return
    ops.forEach(op => {
      const classMatch = selectedClasses.size === 0 || selectedClasses.has(op.profession)
      if (classMatch) result.push({ rarity: r, op })
    })
  })
  if (ocrPriority.value.length > 0) {
    result.sort((a, b) => {
      const ai = ocrPriority.value.indexOf(a.op.name)
      const bi = ocrPriority.value.indexOf(b.op.name)
      const aIdx = ai === -1 ? Infinity : ai
      const bIdx = bi === -1 ? Infinity : bi
      return aIdx - bIdx
    })
  }
  return result
})

function getRarityNum(rarity: string): number {
  return parseInt(rarity)
}

function getFirstChar(name: string): string {
  return name.charAt(0)
}

function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`.replace(/\/{2,}/g, '/')
}

function getAvatarUrl(avatarUrl?: string): string {
  if (!avatarUrl) return ''
  return assetUrl('wiki_upload/images/' + avatarUrl.replace(/^\/+/, ''))
}

function getSkillIconUrl(skill: OperatorSkill): string {
  // 技能图标使用 data 中的路径
  return assetUrl(skill.icon.replace(/^\/+/, ''))
}

function saveFilters() {
  localStorage.setItem('operatorFilter_stars', JSON.stringify(Array.from(selectedStars)))
  localStorage.setItem('operatorFilter_classes', JSON.stringify(Array.from(selectedClasses)))
}

function toggleStar(r: string) {
  if (selectedStars.has(r)) selectedStars.delete(r)
  else selectedStars.add(r)
  saveFilters()
}

function toggleClass(p: string) {
  if (selectedClasses.has(p)) selectedClasses.delete(p)
  else selectedClasses.add(p)
  saveFilters()
}

function toggleOperator(op: Operator) {
  const visibleSkills = getVisibleSkills(op)
  if (selectedOperators.has(op.name)) {
    selectedOperators.delete(op.name)
    visibleSkills.forEach((skill) => {
      selectedSkills.delete(op.name + '::' + skill.name)
    })
  } else {
    selectedOperators.add(op.name)
    if (visibleSkills.length > 0) {
      visibleSkills.forEach((skill) => {
        selectedSkills.delete(op.name + '::' + skill.name)
      })
      selectedSkills.add(op.name + '::' + visibleSkills[visibleSkills.length - 1].name)
    }
  }
}

function toggleSkill(opName: string, skillKey: string) {
  // 手动点击技能后，移除低可信度标记
  lowGapOperators.delete(opName)

  if (selectedSkills.has(skillKey)) {
    selectedOperators.delete(opName)
    const op = findOperatorByName(opName)
    if (op) {
      op.skills.forEach((skill) => {
        selectedSkills.delete(opName + '::' + skill.name)
      })
    }
    return
  }
  if (!selectedOperators.has(opName)) {
    selectedOperators.add(opName)
  }
  const op = findOperatorByName(opName)
  if (op) {
    op.skills.forEach((skill) => {
      selectedSkills.delete(opName + '::' + skill.name)
    })
  }
  selectedSkills.add(skillKey)
}

function findOperatorByName(name: string): Operator | undefined {
  for (const rarity of RARITIES) {
    const ops = allOperators.value[rarity]
    if (ops) {
      const found = ops.find(op => op.name === name)
      if (found) return found
    }
  }
  return undefined
}

function isSelected(name: string) {
  return selectedOperators.has(name)
}

function isSkillSelected(skillKey: string) {
  return selectedSkills.has(skillKey)
}

function notify(message: string, type: 'success' | 'warning' | 'error' | 'info' = 'info') {
  const container = document.createElement('div')
  const palette = {
    error: { bg: '#fef0f0', color: '#f56c6c', border: '#fbc4c4' },
    warning: { bg: '#fdf6ec', color: '#e6a23c', border: '#f5dab1' },
    success: { bg: '#f0f9eb', color: '#67c23a', border: '#c2e7b0' },
    info: { bg: '#eef2ff', color: '#4361ee', border: '#d6dcff' },
  }[type]
  container.style.cssText = `
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    padding: 10px 16px;
    border-radius: 8px;
    color: ${palette.color};
    background: ${palette.bg};
    border: 1px solid ${palette.border};
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
    font-size: 13px;
    font-family: inherit;
  `
  container.textContent = message
  document.body.appendChild(container)
  window.setTimeout(() => {
    container.remove()
  }, 2200)
}

function notifyNotification(message: string, title: string, type: 'success' | 'warning' | 'error' | 'info' = 'info', autoClose = true) {
  const container = document.createElement('div')
  container.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 9999;
    min-width: 320px;
    max-width: 420px;
    padding: 14px 16px;
    border-radius: 8px;
    background: #ffffff;
    border: 1px solid #e4e7ed;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
    animation: slideIn 0.3s ease-out;
    font-family: inherit;
  `

  const colors = {
    error: { border: '#f56c6c', icon: '✕', iconColor: '#f56c6c', messageColor: '#606266' },
    warning: { border: '#e6a23c', icon: '⚠', iconColor: '#e6a23c', messageColor: '#606266' },
    success: { border: '#67c23a', icon: '✓', iconColor: '#67c23a', messageColor: '#606266' },
    info: { border: '#4361ee', icon: 'ℹ', iconColor: '#4361ee', messageColor: '#606266' }
  }

  const color = colors[type]
  container.style.borderLeft = `3px solid ${color.border}`

  container.innerHTML = `
    <div style="display: flex; align-items: flex-start; gap: 12px;">
      <span style="font-size: 16px; color: ${color.iconColor}; flex-shrink: 0;">${color.icon}</span>
      <div style="flex: 1; min-width: 0;">
        <div style="font-size: 14px; font-weight: 600; color: #303133; margin-bottom: 4px;">${title}</div>
        <div style="font-size: 13px; color: ${color.messageColor}; line-height: 1.5; word-break: break-word;">${message}</div>
      </div>
      <button onclick="this.parentElement.parentElement.remove()" style="background: none; border: none; color: #909399; cursor: pointer; font-size: 16px; padding: 0; line-height: 1;">✕</button>
    </div>
  `

  document.body.appendChild(container)
  currentNotification = container

  if (!document.getElementById('notification-styles')) {
    const style = document.createElement('style')
    style.id = 'notification-styles'
    style.textContent = `
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
      }
    `
    document.head.appendChild(style)
  }

  if (autoClose) {
    window.setTimeout(() => {
      container.style.animation = 'slideOut 0.3s ease-in forwards'
      window.setTimeout(() => container.remove(), 300)
    }, 4000)
  }
}

function isStarActive(r: string) {
  return selectedStars.has(r)
}

function isClassActive(p: string) {
  return selectedClasses.has(p)
}

function resolveOperatorsFromOcrLines(lines: Array<{ text: string; score?: number }>) {
  const selections: Array<{ rawText: string; matchedName: string; confidence: number }> = []
  const seen = new Set<string>()
  const allOperatorData = Object.values(allOperators.value).flatMap((ops) => ops)

  lines.forEach((line) => {
    const trimmed = line.text?.trim()
    if (!trimmed) return

    const nameMatch = matchOperatorName(trimmed, allOperatorData)
    if (!nameMatch.name || nameMatch.confidence < 0.64 || nameMatch.operators.length === 0) return

    if (seen.has(nameMatch.name)) return
    seen.add(nameMatch.name)

    selections.push({
      rawText: trimmed,
      matchedName: nameMatch.name,
      confidence: nameMatch.confidence,
    })
  })

  return selections
}

function applySkillRecognitionSelections(ocrSelections: Array<{ matchedName: string }>) {
  selectedOperators.clear()
  selectedSkills.clear()
  lowGapOperators.clear()

  const skillItems = skillResult.value?.items ?? []
  const selectedSkillByOperator = new Map<string, string>()

  skillItems.forEach((item, itemIndex) => {
    if (!item.matchedName) return
    const selection = ocrSelections.find((entry) => entry.matchedName === item.matchedName)
    if (!selection) return

    const chosenCandidate = item.best
    if (!chosenCandidate?.skill.name) return

    selectedSkillByOperator.set(item.matchedName, chosenCandidate.skill.name)

    // 检测 low-gap 状态，使用 op.name（可能带有职业标识）
    if (item.status === 'low-gap') {
      const op = findOperatorByName(item.matchedName)
      if (op) {
        lowGapOperators.add(op.name)
      }
    }
  })

  ocrSelections.forEach((selection) => {
    const op = findOperatorByName(selection.matchedName)
    if (!op) return

    selectedOperators.add(op.name)
    const visibleSkills = getVisibleSkills(op)
    visibleSkills.forEach((skill) => {
      selectedSkills.delete(op.name + '::' + skill.name)
    })

    const resolvedSkillName = selectedSkillByOperator.get(selection.matchedName)
    if (resolvedSkillName) {
      selectedSkills.add(op.name + '::' + resolvedSkillName)
    } else if (visibleSkills.length > 0) {
      selectedSkills.add(op.name + '::' + visibleSkills[visibleSkills.length - 1].name)
    }
  })
}

async function handleGenerate() {
  const parts: string[] = []
  selectedSkills.forEach((skillKey) => {
    const [opName, skillName] = skillKey.split('::')
    const op = findOperatorByName(opName)
    if (op && skillName) {
      const idx = op.skills.findIndex((skill) => skill.name === skillName) + 1
      if (idx > 0) {
        parts.push(opName + idx)
      }
    }
  })
  selectedOperators.forEach((opName) => {
    const hasSkill = Array.from(selectedSkills).some((key) => key.startsWith(opName + '::'))
    if (!hasSkill) {
      parts.push(opName)
    }
  })
  if (parts.length === 0) return
  const text = parts.join('+')
  try {
    await navigator.clipboard.writeText(text)
    notify('已复制到剪贴板：' + text, 'success')
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    notify('已复制到剪贴板：' + text, 'success')
  }
}

function clearStars() {
  selectedStars.clear()
  saveFilters()
}

function clearClasses() {
  selectedClasses.clear()
  saveFilters()
}

function triggerPaste() {
  pasteTarget.value?.focus()
}

function triggerUpload() {
  fileInput.value?.click()
}

function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  processImage(file)
}

async function processImage(file: File) {
  recognizing.value = true
  recognizingElapsed.value = 0
  recognizeTimer = setInterval(() => recognizingElapsed.value++, 1000)
  ocrProgress.stage = ''
  ocrProgress.percent = 0
  lowGapOperators.clear()
  if (currentNotification) { currentNotification.remove(); currentNotification = null }
  notify('正在识别文字...', 'info')

  try {
    selectedOperators.clear()
    selectedSkills.clear()

    const res = await recognizeImage(file)
    skillResult.value = await recognizeOperatorSkills(file, res.lines)

    const ocrSelections = resolveOperatorsFromOcrLines(res.lines)

    if (ocrSelections.length === 0) {
      notify('未识别到干员，请确认截图中有干员名字', 'warning')
      return
    }

    ocrPriority.value = ocrSelections.map((selection) => selection.matchedName)
    applySkillRecognitionSelections(ocrSelections)

    ocrUsed.value = true
    notify('已识别 ' + ocrSelections.length + ' 个干员：' + ocrSelections.map((selection) => selection.matchedName).join('、'), 'success')

    // 显示 low-gap 警告提示
    if (lowGapOperators.size > 0) {
      const operatorNames = Array.from(lowGapOperators).join('、')
      notifyNotification(`${operatorNames}技能识别可信度较低，请注意查验`, '低可信度警告', 'warning', false)
    }
  } catch (err: any) {
    notify('识别失败：' + (err.message || '未知错误'), 'error')
  } finally {
    if (recognizeTimer) { clearInterval(recognizeTimer); recognizeTimer = null }
    recognizing.value = false
  }
}

async function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  let file: File | null = null
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      file = item.getAsFile()
      break
    }
  }
  if (!file) return
  e.preventDefault()
  processImage(file)
}

function resetSelection() {
  selectedOperators.clear()
  selectedSkills.clear()
  lowGapOperators.clear()
}

function handleImgError(e: Event) {
  const img = e.target as HTMLImageElement
  img.style.display = 'none'
  const placeholder = img.parentElement?.querySelector('.avatar-placeholder') as HTMLElement
  if (placeholder) placeholder.style.display = 'flex'
}

onMounted(async () => {
  const unsubProgress = subscribeOcrProgress((p) => {
    ocrProgress.stage = p.stage
    ocrProgress.percent = p.percent
  })

  try {
    const res = await fetch(assetUrl('data/operators.json'))
    if (!res.ok) throw new Error('加载失败: ' + res.status)
    const rawData = (await res.json()) as RawOperatorData[]

    const grouped: Record<string, Operator[]> = {}
    RARITIES.forEach((rarity) => {
      grouped[rarity] = []
    })

    // 处理职业名称映射
    const PROFESSION_MAP: Record<string, string> = {
      WARRIOR: '近卫',
      TANK: '重装',
      SNIPER: '狙击',
      CASTER: '术师',
      MEDIC: '医疗',
      SUPPORT: '辅助',
      SPECIAL: '特种',
      PIONEER: '先锋',
    }

    // 统计每个名字出现的职业，用于判断是否有多种形态
    const nameProfessions = new Map<string, Set<string>>()
    rawData.forEach((item) => {
      if (item.isNotObtainable) return
      if (!nameProfessions.has(item.name)) {
        nameProfessions.set(item.name, new Set())
      }
      nameProfessions.get(item.name)!.add(item.profession)
    })

    rawData.forEach((item) => {
      // 过滤掉不可获取的干员
      if (item.isNotObtainable) return

      // rarity 是 0-5，实际星级是 rarity + 1
      const rarityNum = (item.rarity ?? 0) + 1
      const rarityKey = `${rarityNum}星`
      if (!RARITIES.includes(rarityKey as any)) return

      // 对于有多种形态的干员，给非默认形态加上职业标识
      const professions = nameProfessions.get(item.name)
      let displayName = item.name
      if (professions && professions.size > 1 && item.profession !== 'CASTER') {
        const professionName = PROFESSION_MAP[item.profession] || item.profession
        displayName = `${item.name}（${professionName}）`
      }

      const normalized: Operator = {
        name: displayName,
        profession: PROFESSION_MAP[item.profession] || item.profession,
        rarity: rarityNum,
        // 头像路径：wiki_upload/images/{星级}/{干员名}.png
        avatar_url: `${rarityNum}星/${item.name}.png`,
        skills: (item.skills || []).map((skill) => ({
          name: skill.name,
          icon: skill.icon,
          skillId: skill.skillId,
        })),
      }

      if (grouped[rarityKey]) {
        grouped[rarityKey].push(normalized)
      }
    })

    allOperators.value = grouped
  } catch (err: any) {
    loadError.value = err.message || '加载失败'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="operators-page">
    <div class="filter-bar">
      <div class="filter-left">
        <div class="filter-row">
          <span class="filter-label">星级</span>
          <div class="filter-group">
            <button v-for="(r, i) in RARITIES" :key="r" class="filter-btn" :class="['star-' + (i + 1), { active: isStarActive(r) }]" @click="toggleStar(r)">
              {{ i + 1 }}★
            </button>
            <button class="filter-btn" :class="{ active: selectedStars.size === 0 }" @click="clearStars" title="不限星级">不限</button>
          </div>
        </div>
        <div class="filter-row">
          <span class="filter-label">职业</span>
          <div class="filter-group">
            <button v-for="p in PROFESSIONS" :key="p" class="filter-btn" :class="{ active: isClassActive(p) }" @click="toggleClass(p)">
              {{ p }}
            </button>
            <button class="filter-btn" :class="{ active: selectedClasses.size === 0 }" @click="clearClasses" title="不限职业">不限</button>
          </div>
        </div>
      </div>
      <div class="filter-right">
        <div class="filter-row">
          <template v-if="ocrProgress.stage">
            <div class="download-progress-wrap">
              <div class="download-progress-text">{{ ocrProgress.stage }}</div>
              <div class="download-progress-bar"><div class="download-progress-fill" :style="{ width: ocrProgress.percent + '%' }"></div></div>
              <div class="download-progress-time" v-if="recognizingElapsed > 0">已用时 {{ recognizingElapsed }}s</div>
            </div>
          </template>
          <template v-else-if="recognizing">
            <div class="download-progress-wrap">
              <div class="download-progress-text">正在识别中...</div>
              <div class="download-progress-time" v-if="recognizingElapsed > 0">已用时 {{ recognizingElapsed }}s</div>
            </div>
          </template>
          <template v-else-if="!ocrUsed">
            <span class="download-hint">初次使用需要下载识图库，可能需要一定时间</span>
          </template>
          <button class="mode-toggle-btn" :class="{ active: e1Mode }" @click="e1Mode = !e1Mode">{{ e1Mode ? '精一模式' : '精二模式' }}</button>
          <button class="mode-toggle-btn" :class="{ active: skillDisplayMode === 1 }" @click="skillDisplayMode = skillDisplayMode === 0 ? 1 : 0">{{ skillDisplayMode === 0 ? '☰ 文字' : '▣ 图标' }}</button>
        </div>
        <div class="filter-row">
          <input ref="fileInput" type="file" accept="image/*" style="display:none" @change="handleFileUpload" />
          <div class="paste-group">
            <button class="upload-btn" @click="triggerUpload" :disabled="recognizing" title="上传图片">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            </button>
            <textarea ref="pasteTarget" class="paste-input" :placeholder="recognizing ? '识别中...' : '粘贴图片进行识别'" :disabled="recognizing" @paste="handlePaste" readonly></textarea>
          </div>
          <button class="reset-selection-btn" @click="resetSelection" :disabled="selectedOperators.size === 0">重置选中</button>
          <button class="generate-btn" @click="handleGenerate" :disabled="selectedOperators.size === 0">生成</button>
        </div>
      </div>
    </div>

    <div class="stats-bar">
      <span>显示: <span class="count">{{ displayCount }}</span> / {{ totalCount }} 干员</span>
      <span class="selected-info" v-if="selectedInfo">{{ selectedInfo }}</span>
    </div>


    <div v-if="loading" class="empty-state">加载中...</div>
    <div v-else-if="loadError" class="empty-state">加载 operators.json 失败: {{ loadError }}</div>

    <!-- 技能识别结果展示 -->
    <div v-if="skillResult && skillResult.items.length > 0" class="skill-crop-section">
      <div class="skill-crop-grid">
        <div
          v-for="(item, index) in skillResult.items"
          :key="index"
          class="skill-crop-card"
          :class="{ 'low-score': item.best && item.best.score < 0.68 }"
        >
          <img v-if="item.cropDataUrl" :src="item.cropDataUrl" class="skill-crop-image" :alt="item.matchedName || ''" />
          <div class="skill-crop-name">{{ item.matchedName }}</div>
          <div v-if="item.best" class="skill-crop-score" :class="{ 'low': item.best.score < 0.68 }">
            {{ (item.best.score * 100).toFixed(0) }}%
          </div>
        </div>
      </div>
    </div>

    <div class="operators-grid" :class="{ 'e1-mode': e1Mode }">
      <template v-for="{ rarity, op } in filteredOperators" :key="op.name">
        <div class="operator-card" :class="{ selected: isSelected(op.name), 'low-gap': lowGapOperators.has(op.name) }" :data-rarity="getRarityNum(rarity)" @click="toggleOperator(op)">
          <div class="avatar-wrapper">
            <div class="rarity-badge">★{{ getRarityNum(rarity) }}</div>
            <img v-if="getAvatarUrl(op.avatar_url)" :src="getAvatarUrl(op.avatar_url)" :alt="op.name" loading="lazy" @error="handleImgError" />
            <div class="avatar-placeholder" style="display: none">{{ getFirstChar(op.name) }}</div>
          </div>
          <div class="operator-info">
            <div class="operator-name" :title="op.name">{{ op.name }}</div>
            <div class="operator-profession">{{ op.profession }}</div>
            <div v-if="skillDisplayMode === 0" class="skills-icon-row">
              <div v-for="idx in (e1Mode ? 2 : 3)" :key="idx" class="skill-icon-slot" :class="{ empty: !getVisibleSkills(op)[idx - 1], selected: getVisibleSkills(op)[idx - 1] && isSkillSelected(op.name + '::' + getVisibleSkills(op)[idx - 1].name) }" @click.stop="getVisibleSkills(op)[idx - 1] && toggleSkill(op.name, op.name + '::' + getVisibleSkills(op)[idx - 1].name)">
                <img v-if="getVisibleSkills(op)[idx - 1]" :src="getSkillIconUrl(getVisibleSkills(op)[idx - 1])" :alt="getVisibleSkills(op)[idx - 1].name" :title="getVisibleSkills(op)[idx - 1].name" class="skill-icon-img" @error="($event.target as HTMLImageElement).style.display='none'" />
              </div>
            </div>
            <div v-else class="skills-list">
              <template v-if="getVisibleSkills(op).length > 0">
                <span v-for="skill in getVisibleSkills(op)" :key="skill.skillId || skill.name" class="skill-tag" :class="{ selected: isSkillSelected(op.name + '::' + skill.name) }" :title="skill.name" @click.stop="toggleSkill(op.name, op.name + '::' + skill.name)">
                  <img :src="getSkillIconUrl(skill)" :alt="skill.name" class="skill-icon" @error="($event.target as HTMLImageElement).style.display='none'" />
                  {{ skill.name }}
                </span>
              </template>
              <span v-else class="no-skills">无技能</span>
            </div>
          </div>
        </div>
      </template>
      <div v-if="filteredOperators.length === 0" class="empty-state">没有符合条件的干员</div>
      <div class="bottom-spacer"></div>
    </div>
  </div>
</template>

<style scoped>
.operators-page { min-height: 100vh; background: #f7fafc; color: #303133; position: relative; }
.filter-bar { position: sticky; top: 0; z-index: 100; background: #ffffff; border-bottom: 1px solid #e4e7ed; padding: 12px 20px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04); display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
.filter-left { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.filter-right { flex: 0 0 auto; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
.filter-row { display: flex; align-items: center; gap: 10px}
.download-hint { font-size: 13px; color: #909399; line-height: 1; }
.download-progress-wrap { display: flex; flex-direction: column; gap: 3px; width: 232px; margin-right: 8px; }
.download-progress-text { font-size: 12px; color: #606266; white-space: nowrap; }
.download-progress-bar { width: 100%; height: 3px; background: #e4e7ed; border-radius: 999px; overflow: hidden; }
.download-progress-fill { height: 100%; background: #4361ee; border-radius: 999px; transition: width 0.3s ease; }
.download-progress-time { font-size: 12px; color: #909399; }
.mode-toggle-btn { padding: 5px 12px; border: 1px solid #e4e7ed; border-radius: 8px; background: #ffffff; color: #303133; font-size: 13px; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease; }
.mode-toggle-btn:hover { background: #f5f7fa; border-color: #e4e7ed; color: #4361ee; }
.mode-toggle-btn.active { background: #eef2ff; border-color: #4361ee; color: #4361ee; }
.filter-label { font-size: 13px; color: #606266; min-width: 50px; user-select: none; }
.filter-group { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.filter-btn { display: inline-flex; align-items: center; padding: 5px 14px; border: 1px solid transparent; border-radius: 6px; background: #f5f7fa; color: #303133; font-size: 13px; cursor: pointer; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease; user-select: none; white-space: nowrap; }
.filter-btn:hover { border-color: transparent; color: #4361ee; background: #eef2ff; }
.filter-btn.active { background: #eef2ff; border-color: transparent; color: #4361ee; box-shadow: none; font-weight: 500; }
.star-1.active { color: #606266; background: #eef0f2; }
.star-2.active { color: #5b8f3e; background: #f2f7ee; }
.star-3.active { color: #409eff; background: #ecf5ff; }
.star-4.active { color: #8a5cc5; background: #f6f0fb; }
.star-5.active { color: #c98a1a; background: #fff7ea; }
.star-6.active { color: #4361ee; background: #eef2ff; }
.paste-group { display: flex; align-items: stretch; background: #f5f7fa; border-radius: 8px; overflow: hidden; }
.paste-group:focus-within { background: #ffffff; box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.35); }
.upload-btn { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 0; border-right: 0; border-radius: 0; background: transparent; color: #606266; cursor: pointer; transition: color 0.15s ease; flex-shrink: 0; padding: 0; }
.upload-btn:hover:not(:disabled) { background: transparent; color: #4361ee; }
.upload-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.paste-input { width: 200px; height: 32px; line-height: 23px; padding: 4px 10px; border: 0; border-radius: 0; background: transparent; color: #303133; font-size: 13px; resize: none; outline: none; transition: none; vertical-align: middle; box-sizing: border-box; overflow-y: hidden; }
.paste-input:focus { border-color: transparent; background: transparent; box-shadow: none; }
.paste-input:disabled { opacity: 0.5; cursor: not-allowed; }
.paste-input::placeholder { color: #909399; }
.reset-selection-btn { padding: 6px 16px; border: 1px solid #e4e7ed; border-radius: 8px; background: #ffffff; color: #606266; font-size: 13px; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease; }
.reset-selection-btn:hover:not(:disabled) { background: #f5f7fa; border-color: #e4e7ed; color: #303133; }
.reset-selection-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.generate-btn { margin-left: auto; padding: 6px 20px; border: 1px solid #409eff; border-radius: 8px; background: #409eff; color: #ffffff; font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.15s ease; }
.generate-btn:hover:not(:disabled) { background: #66b1ff; box-shadow: none; }
.generate-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.stats-bar { padding: 10px 20px; background: #f7fafc; font-size: 13px; color: #606266; display: flex; align-items: center; gap: 16px; border-bottom: 0; }
.stats-bar .count { color: #4361ee; font-weight: 600; }
.selected-info { margin-left: auto; font-size: 12px; color: #909399; }
.operators-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; padding: 16px 20px; }
.operator-card { background: transparent; border: 1px solid transparent; border-radius: 6px; overflow: visible; cursor: pointer; transition: none; position: relative; }
.operator-card:hover .operator-name { color: #4361ee; }
.operator-card.selected { border-color: transparent; box-shadow: none; }
.operator-card.selected .operator-name { color: #4361ee; }
.operator-card.selected .avatar-wrapper { box-shadow: none; }
.operator-card.selected::after { content: '✓'; position: absolute; top: 6px; right: 8px; font-size: 12px; color: #ffffff; font-weight: 600; text-shadow: none; z-index: 2; width: 18px; height: 18px; border-radius: 50%; background: #4361ee; display: flex; align-items: center; justify-content: center; line-height: 18px; text-align: center; }
.operator-card.low-gap { animation: none; border-color: transparent !important; }
.operator-card.low-gap .avatar-wrapper { box-shadow: 0 0 0 2px #e6a23c; }
.operator-card.low-gap::after { content: '!'; position: absolute; top: 6px; right: 8px; font-size: 12px; color: #ffffff; font-weight: 700; text-shadow: none; z-index: 2; width: 18px; height: 18px; border-radius: 50%; background: #e6a23c; display: flex; align-items: center; justify-content: center; line-height: 18px; text-align: center; }
.operator-card[data-rarity='1'],
.operator-card[data-rarity='2'],
.operator-card[data-rarity='3'],
.operator-card[data-rarity='4'],
.operator-card[data-rarity='5'],
.operator-card[data-rarity='6'] { border-color: transparent; }
.operator-card[data-rarity='1'].selected,
.operator-card[data-rarity='2'].selected,
.operator-card[data-rarity='3'].selected,
.operator-card[data-rarity='4'].selected,
.operator-card[data-rarity='5'].selected,
.operator-card[data-rarity='6'].selected { border-color: transparent; box-shadow: none; }
.avatar-wrapper { width: 100%; aspect-ratio: 1; background: #e4e7ed; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden; border-radius: 6px; }
.avatar-wrapper img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.2s ease; }
.operator-card:hover .avatar-wrapper img { transform: scale(1.04); }
.avatar-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 36px; font-weight: 600; color: #909399; background: #e4e7ed; }
.rarity-badge { position: absolute; top: 4px; left: 4px; background: rgba(0, 0, 0, 0.55); padding: 1px 6px; border-radius: 4px; font-size: 11px; color: #ffffff; font-weight: 600; z-index: 1; }
.operator-info { padding: 8px 4px; }
.operator-name { font-size: 13px; font-weight: 500; color: #303133; margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.operator-profession { font-size: 12px; color: #909399; margin-bottom: 6px; }
.skills-list { display: flex; flex-wrap: wrap; gap: 4px; }
.skill-tag { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; background: #f5f7fa; border: 1px solid transparent; border-radius: 6px; font-size: 12px; color: #606266; cursor: pointer; transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease; user-select: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-tag:hover { background: #eef2ff; border-color: transparent; color: #4361ee; }
.skill-tag.selected { background: #eef2ff; border-color: #4361ee; color: #4361ee; box-shadow: none; }
.skill-icon { width: 18px; height: 18px; object-fit: contain; flex-shrink: 0; }
.skills-icon-row { display: flex; gap: 4px; padding: 2px; }
.skill-icon-slot { flex: 1; background: #e4e7ed; border: 1px solid transparent; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease; position: relative; padding: 0; line-height: 0; overflow: visible; border-radius: 4px; }
.skill-icon-slot.empty { background: transparent; border-color: transparent; cursor: default; pointer-events: none; }
.skill-icon-slot:not(.empty):hover { background: #e4e7ed; border-color: transparent; }
.e1-mode .skill-icon-slot:not(.empty) { transform: scale(0.9); }
.skill-icon-slot.selected { z-index: 1; box-shadow: none; border-color: transparent; background: #e4e7ed; }
.skill-icon-slot.selected .skill-icon-img { transform: translateY(-4px); }
.skill-icon-slot.selected::before { content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: #4361ee; box-shadow: none; z-index: 3; border-radius: 0; }
.skill-icon-img { display: block; width: calc(100% + 4px); height: calc(100% + 4px); margin: -2px; object-fit: contain; }
.no-skills { font-size: 11px; color: #909399; font-style: normal; }
.empty-state { text-align: center; padding: 60px 20px; color: #909399; font-size: 15px; grid-column: 1 / -1; }
.bottom-spacer { height: 40px; grid-column: 1 / -1; }

.skill-crop-section {
  margin: 0 20px;
  padding: 8px;
  background: #ffffff;
  border: 1px solid #e4e7ed;
  border-radius: 6px;
}
.skill-crop-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.skill-crop-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: #f5f7fa;
  border: 1px solid transparent;
  border-radius: 6px;
  font-size: 12px;
}
.skill-crop-card.low-score {
  border-color: #f56c6c;
  background: #fef0f0;
}
.skill-crop-image {
  width: 40px;
  height: 40px;
  object-fit: contain;
  image-rendering: pixelated;
  border-radius: 4px;
}
.skill-crop-name {
  color: #303133;
  font-weight: 500;
}
.skill-crop-score {
  color: #67c23a;
  font-weight: 600;
}
.skill-crop-score.low {
  color: #f56c6c;
}

@media (max-width: 600px) {
  .operators-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; padding: 10px; }
  .filter-bar { padding: 10px 12px; }
  .filter-btn { padding: 4px 10px; font-size: 12px; }
  .operator-name { font-size: 12px; }
  .skill-tag { font-size: 10px; padding: 1px 6px; }
  .skill-crop-section { margin: 8px 12px; }
}
</style>
