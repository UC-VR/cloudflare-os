// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
// LOCAL PATCH: explicit direct-routing bypass for AI Gateway mode — remove when fixed upstream
//
// Unlike every other frontend test in this package, this file mounts the REAL @cloudflare/kumo
// Select/Switch/Collapsible/SensitiveInput (only `useKumoToastManager` is mocked) instead of
// mocking Kumo wholesale. That wholesale-mocking convention is exactly why the three access-
// headers/direct-routing bugs below shipped behind a fully green test suite: a mocked Select
// can never emit the real Base UI `null` that crashes decodeSelection(), and a mocked submit
// path can never exercise the real header-row state machine that patch 1 silently broke.
//
// Harness notes (see the "not to throw" pattern used throughout): jsdom has no PointerEvent
// constructor and no pointer-capture methods, both of which Base UI's Switch/Select need to
// process a click; a real click on the Select's trigger only needs mousedown+click, but
// committing an option needs pointerdown+click, and the Switch needs a real `PointerEvent`
// instance (not a plain MouseEvent) or its internal handler throws asynchronously outside our
// control. `scrollIntoView` is also missing (jsdom has no layout engine).

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiGatewayInfo, AiModelConfig, AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// LOCAL PATCH: explicit direct-routing bypass for AI Gateway mode — remove when fixed upstream
// jsdom ships no PointerEvent constructor at all; Base UI's Switch/Select internals require one
// (not a plain MouseEvent) to process pointerdown, and call pointer-capture/scrollIntoView APIs
// jsdom also doesn't implement.
class PointerEventPolyfill extends MouseEvent {
  pointerId: number
  pointerType: string
  isPrimary: boolean
  constructor(type: string, params: PointerEventInit = {}) {
    super(type, params)
    this.pointerId = params.pointerId ?? 1
    this.pointerType = params.pointerType ?? 'mouse'
    this.isPrimary = params.isPrimary ?? true
  }
}
// @ts-expect-error -- our polyfill class doesn't implement every PointerEvent property, only
// the ones Base UI's handlers actually read.
window.PointerEvent = PointerEventPolyfill
// jsdom declares these DOM APIs in its types but doesn't implement them at runtime; filling in
// the missing runtime behavior needs no type suppression.
HTMLElement.prototype.setPointerCapture ??= () => {}
HTMLElement.prototype.releasePointerCapture ??= () => {}
HTMLElement.prototype.hasPointerCapture ??= () => false
HTMLElement.prototype.scrollIntoView ??= () => {}

const toastAdd = vi.fn()

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  return {
    ...actual,
    useKumoToastManager: () => ({ add: toastAdd }),
  }
})

import AddModelModal from './AddModelModal'

const GATEWAY_ANTHROPIC_ONLY: AiGatewayInfo = { enabled: true, enabledProviders: ['anthropic'] }

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function inputForLabel(labelText: string): HTMLInputElement {
  const label = [...document.querySelectorAll('label')].find(l => l.textContent === labelText)
  if (!label) throw new Error(`no label found with text "${labelText}"`)
  const id = label.getAttribute('for')!
  return document.getElementById(id) as HTMLInputElement
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent === text)
  if (!button) throw new Error(`no button found with text "${text}"`)
  return button as HTMLButtonElement
}

// LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
// The header-row Name/Value fields have no <label> element (see AddModelModal.tsx), only an
// aria-label -- inputForLabel() above can't find them. Selecting by accessible name (not by
// placeholder+index, as the rest of this file's header-row tests do) is what actually catches
// a labels-swapped-but-bindings-correct regression: if a future edit swaps the two aria-label
// strings, this resolves to the WRONG underlying field, and the resulting header content is
// wrong even though nothing in buildHeaders() changed.
function inputByAriaLabel(label: string): HTMLInputElement {
  const input = document.querySelector(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`no input found with aria-label "${label}"`)
  return input as HTMLInputElement
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

// The Switch needs a real PointerEvent (see the polyfill comment above) or its internal handler
// throws asynchronously, outside any try/catch here.
async function toggleSwitch(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

async function openSelect() {
  await click(document.querySelector('button[role="combobox"]')!)
}

// Committing a Select option needs pointerdown+click (mousedown+click only opens the popup).
async function pickOption(optionText: string) {
  const option = [...document.querySelectorAll('[role="option"]')]
    .find(o => o.textContent === optionText)
  if (!option) throw new Error(`no option found with text "${optionText}"`)
  await act(async () => {
    option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}

describe('AddModelModal (real @cloudflare/kumo Select/Switch)', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  let addModel: ReturnType<typeof vi.fn>
  let api: RpcStub<AuthenticatedApi>

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    toastAdd.mockClear()
  })

  async function render(aiConfig: AiGatewayInfo | null) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    addModel = vi.fn().mockResolvedValue(undefined)
    api = { addModel } as unknown as RpcStub<AuthenticatedApi>
    await act(async () => {
      root!.render(
        <AddModelModal
          visible={true}
          onCancel={() => {}}
          onSuccess={() => {}}
          authenticatedApi={api}
          aiConfig={aiConfig}
        />,
      )
      await Promise.resolve()
    })
  }

  // Discriminates fixes 2b (header rows wiped on re-selection) and 2c (no read-back of what was
  // saved): re-selecting the SAME provider after adding headers must not wipe them (2b), and the
  // success toast must name the saved header keys (2c).
  it('submits apiUrl, both headers, and routing:"direct" after toggling direct routing and picking a provider', async () => {
    await render(GATEWAY_ANTHROPIC_ONLY)

    const directSwitch = document.querySelector('[role="switch"]')!
    await toggleSwitch(directSwitch)

    await openSelect()
    await pickOption('Other Anthropic...')

    setInputValue(inputForLabel('Model ID'), 'claude-test-model')
    setInputValue(inputForLabel('Display Name'), 'Claude Test Model')
    setInputValue(inputForLabel('API Token'), 'sk-ant-test-token')

    await click(buttonWithText('Advanced Settings'))
    setInputValue(inputForLabel('API URL'), 'https://access-proxy.example.com/anthropic')

    await click(buttonWithText('Add header'))
    await click(buttonWithText('Add header'))
    let nameInputs = [...document.querySelectorAll<HTMLInputElement>('input[placeholder="Header name"]')]
    let valueInputs = [...document.querySelectorAll<HTMLInputElement>('input[placeholder="Header value"]')]
    setInputValue(nameInputs[0], 'CF-Access-Client-Id')
    setInputValue(valueInputs[0], 'client-id-value')
    setInputValue(nameInputs[1], 'CF-Access-Client-Secret')
    setInputValue(valueInputs[1], 'client-secret-value')

    // Re-select the SAME provider (re-picking "Other Anthropic..." from the still-open flow).
    // Bug 2b wiped headerRows on every call to handleModelSelect, including this one -- if that
    // regresses, the assertions right below fail because buildHeaders() sees an empty array.
    // (handleModelSelect unconditionally resets modelId/displayName/apiToken/apiUrl on every
    // call, re-selection included -- that reset is pre-existing, intended behavior for those
    // fields, unrelated to the headerRows bug this step targets, so they're refilled below.)
    await openSelect()
    await pickOption('Other Anthropic...')

    // Header rows and the values just typed must have survived the re-selection.
    nameInputs = [...document.querySelectorAll<HTMLInputElement>('input[placeholder="Header name"]')]
    valueInputs = [...document.querySelectorAll<HTMLInputElement>('input[placeholder="Header value"]')]
    expect(nameInputs).toHaveLength(2)
    expect(nameInputs[0].value).toBe('CF-Access-Client-Id')
    expect(nameInputs[1].value).toBe('CF-Access-Client-Secret')

    setInputValue(inputForLabel('Model ID'), 'claude-test-model')
    setInputValue(inputForLabel('Display Name'), 'Claude Test Model')
    setInputValue(inputForLabel('API Token'), 'sk-ant-test-token')
    setInputValue(inputForLabel('API URL'), 'https://access-proxy.example.com/anthropic')

    await click(buttonWithText('Add Model'))

    expect(addModel).toHaveBeenCalledTimes(1)
    const [profile, config] = addModel.mock.calls[0] as [AiChatAuthorInfo, AiModelConfig]
    expect(profile.id).toBe('claude-test-model')
    expect(config).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test-model',
      apiToken: 'sk-ant-test-token',
      apiUrl: 'https://access-proxy.example.com/anthropic',
      routing: 'direct',
      headers: {
        'CF-Access-Client-Id': 'client-id-value',
        'CF-Access-Client-Secret': 'client-secret-value',
      },
    })

    // Fix 2c: the success toast surfaces which header NAMES were saved (never values).
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('CF-Access-Client-Id'),
    }))
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining('CF-Access-Client-Secret'),
    }))
    // Never the value.
    const [toastCall] = toastAdd.mock.calls[0]
    expect(JSON.stringify(toastCall)).not.toContain('client-id-value')
    expect(JSON.stringify(toastCall)).not.toContain('client-secret-value')
  })

  // Discriminates fix 1 (the null crash): reproduces the exact repro path from patch 3 -- select
  // a provider only reachable via the direct-routing bypass, then flip the bypass back off,
  // which shrinks the option list out from under the selected value. Before the fix, Base UI's
  // Select emits `null` through onValueChange here and decodeSelection(null) throws.
  it('does not throw when the selected option disappears from a shrinking option list', async () => {
    await render(GATEWAY_ANTHROPIC_ONLY)

    const directSwitch = document.querySelector('[role="switch"]')!
    await toggleSwitch(directSwitch) // reveals openai (not in enabledProviders)

    await openSelect()
    await pickOption('Other OpenAI...')
    expect(document.querySelector('button[role="combobox"]')!.textContent).toBe('Other OpenAI...')

    let thrown: unknown
    try {
      await toggleSwitch(directSwitch) // back off -- openai drops out of the option list
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeUndefined()
  })

  // Discriminates fix 2a: a header row with a name but no value (or vice versa) must be
  // rejected by validate() rather than silently dropped by buildHeaders().
  it('rejects a half-filled header row instead of silently dropping it', async () => {
    await render({ enabled: false })

    await openSelect()
    await pickOption('Other Anthropic...')

    setInputValue(inputForLabel('Model ID'), 'claude-test-model')
    setInputValue(inputForLabel('Display Name'), 'Claude Test Model')
    setInputValue(inputForLabel('API Token'), 'sk-ant-test-token')

    await click(buttonWithText('Advanced Settings'))
    await click(buttonWithText('Add header'))
    const nameInputs = [...document.querySelectorAll<HTMLInputElement>('input[placeholder="Header name"]')]
    setInputValue(nameInputs[0], 'CF-Access-Client-Id')
    // Value deliberately left blank -- the masked SensitiveInput hides exactly this failure mode.

    await click(buttonWithText('Add Model'))

    expect(addModel).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Every extra header needs both a name and a value')
  })

  // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
  // Selects each field by its accessible name (aria-label), not by placeholder+index like the
  // tests above. This is the actual guard against a labels-swapped-but-bindings-correct
  // regression: if the two aria-label strings below were ever swapped, this test would type
  // the name into what it thinks is the name field but is actually the value-bound one, and
  // the resulting config.headers would come out wrong even though buildHeaders() itself never
  // changed. It also pins that the header-row fields have a real accessible name at all --
  // before this patch they had none (Kumo logs "Input must have an accessible name" for a
  // field with neither `label` nor `aria-label`).
  it('binds the header row fields the accessible-name selectors say they are bound to', async () => {
    await render({ enabled: false })

    await openSelect()
    await pickOption('Other Anthropic...')

    setInputValue(inputForLabel('Model ID'), 'claude-test-model')
    setInputValue(inputForLabel('Display Name'), 'Claude Test Model')
    setInputValue(inputForLabel('API Token'), 'sk-ant-test-token')

    await click(buttonWithText('Advanced Settings'))
    await click(buttonWithText('Add header'))

    setInputValue(inputByAriaLabel('Header 1 name'), 'CF-Access-Client-Id')
    setInputValue(inputByAriaLabel('Header 1 value'), 'client-id-value')

    await click(buttonWithText('Add Model'))

    expect(addModel).toHaveBeenCalledTimes(1)
    const [, config] = addModel.mock.calls[0] as [AiChatAuthorInfo, AiModelConfig]
    expect(config.headers).toEqual({ 'CF-Access-Client-Id': 'client-id-value' })
  })

  // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
  // A header name outside RFC 7230's tchar grammar (here: a space) would make the real fetch()
  // throw later, invisibly. Caught at save time instead.
  it('rejects a header name that is not a legal HTTP token', async () => {
    await render({ enabled: false })

    await openSelect()
    await pickOption('Other Anthropic...')

    setInputValue(inputForLabel('Model ID'), 'claude-test-model')
    setInputValue(inputForLabel('Display Name'), 'Claude Test Model')
    setInputValue(inputForLabel('API Token'), 'sk-ant-test-token')

    await click(buttonWithText('Advanced Settings'))
    await click(buttonWithText('Add header'))
    setInputValue(inputByAriaLabel('Header 1 name'), 'CF Access Client Id')
    setInputValue(inputByAriaLabel('Header 1 value'), 'client-id-value')

    await click(buttonWithText('Add Model'))

    expect(addModel).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain("isn't a valid header name")
  })

  // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
  // The header-row Name/Value fields have no persistent column labels below the placeholder
  // (see AddModelModal.tsx), which makes a full-row transposition -- a value typed into the
  // Name field, a name typed into the Value field -- a plausible UI-induced mistake, not just
  // an inattentive paste. A name shaped like a pasted ID/token/secret (a long digit run) is
  // flagged rather than silently saved.
  it('flags a header name shaped like a pasted value instead of a header name', async () => {
    await render({ enabled: false })

    await openSelect()
    await pickOption('Other Anthropic...')

    setInputValue(inputForLabel('Model ID'), 'claude-test-model')
    setInputValue(inputForLabel('Display Name'), 'Claude Test Model')
    setInputValue(inputForLabel('API Token'), 'sk-ant-test-token')

    await click(buttonWithText('Advanced Settings'))
    await click(buttonWithText('Add header'))
    setInputValue(inputByAriaLabel('Header 1 name'), 'DUMMY-ID-1234')
    setInputValue(inputByAriaLabel('Header 1 value'), 'CF-Access-Client-Id')

    await click(buttonWithText('Add Model'))

    expect(addModel).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('looks like a value, not a header name')
  })
})
