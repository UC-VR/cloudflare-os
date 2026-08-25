import { useState, useEffect } from 'react'
import { Dialog, Button, Input, Select, SensitiveInput, Collapsible, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { AiChatAuthorInfo, AiModelConfig, AiModelProvider, AiGatewayInfo, SUGGESTED_MODELS } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
}

// Placeholder hinting at the shape of each provider's API token.
const API_TOKEN_PLACEHOLDERS: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza...',
  cloudflare: 'Cloudflare API token',
  ollama: '(optional)',
}

// Example used in the custom-model placeholders for providers that have no suggested models
// (currently Ollama, which serves whatever the user has pulled locally).
const FALLBACK_EXAMPLE_MODEL = { modelId: 'gemma4:31b', name: 'Gemma 4 31B' }

// LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
// RFC 7230 field-name = 1*tchar. A name outside this grammar makes the real fetch() throw
// later, invisibly -- catch it at save time instead. Header rows have no persistent labels
// (see the JSX below), so a value pasted into the Name field goes undetected unless it's also
// shape-checked. A bare digit run is too blunt a tell: real header names carry version/year
// suffixes too ("X-Api-Version-2024", "X-Tenant-1234"), which top out around four consecutive
// digits and stay well under 16 characters. A pasted secret is both longer and runs digits
// longer than that, so both conditions have to hold before this is treated as a hard reject.
const HEADER_TCHAR_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const HEADER_NAME_LOOKS_LIKE_VALUE_RE = /\d{5,}/
const HEADER_NAME_LOOKS_LIKE_VALUE_MIN_LENGTH = 16

// Pick an example model to show in the custom-model placeholders for the given provider.
function exampleModel(provider: AiModelProvider): { modelId: string, name: string } {
  const first = Object.entries(SUGGESTED_MODELS[provider])[0]
  return first ? { modelId: first[0], name: first[1].name } : FALLBACK_EXAMPLE_MODEL
}

// Encode a selection into a string value for the Select component.
function encodeSelection(provider: AiModelProvider, modelId?: string): string {
  return modelId ? `${provider}:${modelId}` : `other-${provider}`
}

// Decode a Select value back into a SelectionType.
function decodeSelection(value: string): SelectionType {
  if (value.startsWith('other-')) {
    return { type: 'custom', provider: value.substring(6) as AiModelProvider }
  }
  const colonIndex = value.indexOf(':')
  const provider = value.substring(0, colonIndex) as AiModelProvider
  const modelId = value.substring(colonIndex + 1)
  const displayName = SUGGESTED_MODELS[provider][modelId].name
  return { type: 'suggested', provider, modelId, displayName }
}

// Build the flat list of options for the Select dropdown.
function buildOptions(gatewayMode: boolean, enabledProviders: Set<string> | null) {
  const options: { value: string; label: string; provider: string }[] = []
  const providerOrder = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

  for (const provider of providerOrder) {
    if (enabledProviders && !enabledProviders.has(provider)) continue

    // In gateway mode, suggested models are already built-in, so don't list them.
    if (!gatewayMode) {
      for (const [modelId, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        options.push({
          value: encodeSelection(provider, modelId),
          label: model.name,
          provider,
        })
      }
    }

    options.push({
      value: encodeSelection(provider),
      label: `Other ${PROVIDER_LABELS[provider] || provider}...`,
      provider,
    })
  }

  return options
}

export default function AddModelModal({ visible, onCancel, onSuccess, authenticatedApi, aiConfig }: AddModelModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(null)
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // Form fields (used for custom models)
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [apiUrl, setApiUrl] = useState('')
  // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
  const [headerRows, setHeaderRows] = useState<{ name: string, value: string }[]>([])
  // LOCAL PATCH: explicit direct-routing bypass for AI Gateway mode — remove when fixed upstream
  const [directRouting, setDirectRouting] = useState(false)

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const gatewayMode = aiConfig?.enabled === true
  // LOCAL PATCH: explicit direct-routing bypass for AI Gateway mode — remove when fixed upstream
  // A direct-routed model needs the credential fields even in gateway mode (it isn't going
  // through the gateway), and it isn't limited to the gateway's enabled providers either.
  const useDirectCredentials = !gatewayMode || directRouting
  const enabledProviders: Set<string> | null = gatewayMode && !directRouting
    ? new Set(aiConfig.enabledProviders)
    : null

  // Reset all state when dialog closes
  useEffect(() => {
    if (!visible) {
      setSelection(null)
      setSelectValue(undefined)
      setModelId('')
      setDisplayName('')
      setApiToken('')
      setAccountId('')
      setApiUrl('')
      setHeaderRows([]) // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
      setDirectRouting(false) // LOCAL PATCH: explicit direct-routing bypass for AI Gateway mode — remove when fixed upstream
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

  const handleModelSelect = (value: string) => {
    setSelectValue(value)
    setErrors({})
    const sel = decodeSelection(value)
    setSelection(sel)

    if (sel.type === 'custom') {
      setModelId('')
      setDisplayName('')
    } else {
      setModelId(sel.modelId)
      setDisplayName(sel.displayName)
    }
    setApiToken('')
    setAccountId('')
    setApiUrl(sel.provider === 'ollama' ? 'http://localhost:11434' : '')
    // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
    // Only clear headers when the provider actually changes. The header editor lives inside a
    // collapsible, so wiping it on every re-selection (e.g. re-picking the same provider, or
    // switching model/"Other..." within the same provider) silently discarded typed headers the
    // user could not see happen. Switching providers still clears them: headers are typically
    // provider-specific (e.g. an Access service token for one endpoint, not another).
    if (sel.provider !== selection?.provider) {
      setHeaderRows([])
    }
  }

  // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
  const addHeaderRow = () => setHeaderRows(prev => [...prev, { name: '', value: '' }])
  const updateHeaderRow = (index: number, patch: Partial<{ name: string, value: string }>) => {
    setHeaderRows(prev => prev.map((row, i) => i === index ? { ...row, ...patch } : row))
    setErrors(prev => ({ ...prev, headers: '' }))
  }
  const removeHeaderRow = (index: number) =>
    setHeaderRows(prev => prev.filter((_, i) => i !== index))

  // Fold complete header rows into a plain record; rows with a blank name or value are dropped.
  const buildHeaders = (): Record<string, string> => {
    const result: Record<string, string> = {}
    for (const row of headerRows) {
      const name = row.name.trim()
      const value = row.value.trim()
      // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
      // A row only counts once both the name and value are filled in; a blank value (e.g. an
      // empty CF-Access-Client-Secret) is worse than omitting the header, so drop it silently.
      if (!name || !value) continue
      result[name] = value
    }
    return result
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!selection) {
      newErrors.selection = gatewayMode ? 'Please select a provider' : 'Please select a model'
    }

    if (selection?.type === 'custom') {
      if (!modelId.trim()) newErrors.modelId = 'Please enter the model ID'
      if (!displayName.trim()) newErrors.displayName = 'Please enter a display name'
    }

    const isOllama = selection?.provider === 'ollama'
    const isCloudflare = selection?.provider === 'cloudflare'

    if (useDirectCredentials && selection && !isOllama && !apiToken.trim()) {
      newErrors.apiToken = 'Please enter your API token'
    }

    if (useDirectCredentials && isCloudflare && !accountId.trim()) {
      newErrors.accountId = 'Please enter your Cloudflare account ID'
    }

    if (useDirectCredentials && isOllama && !apiUrl.trim()) {
      newErrors.apiUrl = 'Please enter the Ollama API URL'
    }

    // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
    // Everything below only matters when direct credentials are in play: onSubmit only includes
    // headers when useDirectCredentials is set, and the header editor itself (including the
    // errors.headers display) is only rendered then -- see the JSX gate below. Validating
    // unconditionally used to be a silent dead end: toggle direct on, half-fill a header row,
    // toggle direct off, and Save did nothing, with no error ever shown.
    if (useDirectCredentials) {
      // A half-filled row (name with no value, or value with no name) is silently dropped by
      // buildHeaders() rather than saved -- and since the value field is a masked SensitiveInput,
      // a failed paste there is invisible. Reject it instead of saving a model with no headers.
      if (headerRows.some(r => (r.name.trim() === '') !== (r.value.trim() === ''))) {
        newErrors.headers = 'Every extra header needs both a name and a value'
        setAdvancedOpen(true)
      } else {
        // See HEADER_TCHAR_RE / HEADER_NAME_LOOKS_LIKE_VALUE_RE above for why these two checks
        // exist. Only run once every row is fully filled or fully blank (the check above), so
        // this doesn't pile a second error message onto an already-flagged half-filled row.
        // Referenced by row index rather than by echoing the entered name back into the
        // message: the "looks like a value" branch fires precisely when something that looks
        // like a secret was pasted into the Name column, and this file's own policy elsewhere
        // (see the toast in handleSubmit) is to never surface header values, so the message
        // shouldn't leak one either.
        const illegalNameIndex = headerRows.findIndex(
            r => r.name.trim() !== '' && !HEADER_TCHAR_RE.test(r.name.trim()))
        const valueShapedNameIndex = illegalNameIndex !== -1 ? -1 : headerRows.findIndex(
            r => r.name.trim() !== '' &&
                r.name.trim().length >= HEADER_NAME_LOOKS_LIKE_VALUE_MIN_LENGTH &&
                HEADER_NAME_LOOKS_LIKE_VALUE_RE.test(r.name.trim()))
        if (illegalNameIndex !== -1) {
          newErrors.headers =
              `Header ${illegalNameIndex + 1}'s name isn't a valid header name (letters, ` +
              `digits, and !#$%&'*+-.^_\`|~ only -- no spaces)`
          setAdvancedOpen(true)
        } else if (valueShapedNameIndex !== -1) {
          newErrors.headers =
              `Header ${valueShapedNameIndex + 1}'s name looks like a value, not a header name ` +
              `-- check the Name and Value columns aren't swapped`
          setAdvancedOpen(true)
        }
      }
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const isSuggested = selection!.type === 'suggested'
      const finalModelId = isSuggested ? selection!.modelId : modelId.trim()
      const finalDisplayName = isSuggested ? selection!.displayName : displayName.trim()

      const profile: AiChatAuthorInfo = {
        type: 'agent',
        id: finalModelId,
        name: finalDisplayName,
      }

      // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
      const headers = buildHeaders()

      const config: AiModelConfig = {
        provider: selection!.provider,
        model: finalModelId,
        apiToken: useDirectCredentials ? apiToken.trim() : '',
        ...(useDirectCredentials && accountId.trim() && { accountId: accountId.trim() }),
        ...(useDirectCredentials && apiUrl.trim() && { apiUrl: apiUrl.trim() }),
        ...(useDirectCredentials && Object.keys(headers).length > 0 && { headers }),
        // LOCAL PATCH: explicit direct-routing bypass for AI Gateway mode — remove when fixed upstream
        ...(directRouting && { routing: 'direct' as const }),
      }

      await authenticatedApi.addModel(profile, config)
      // LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream
      // The config is otherwise write-only: nothing ever shows a user what was saved, so a
      // dropped or mistyped header is invisible until the model 403s later. Surface which
      // extra header NAMES were saved (never values) as the cheapest available feedback.
      const headerNames = useDirectCredentials ? Object.keys(headers) : []
      toasts.add({
        title: 'AI model added successfully',
        variant: 'success',
        ...(headerNames.length > 0 && { description: `Extra headers saved: ${headerNames.join(', ')}` }),
      })
      onSuccess()
    } catch (error: any) {
      console.error('Failed to add model:', error)
      toasts.add({ title: 'Failed to add model', variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const options = buildOptions(gatewayMode, enabledProviders)
  const showCustomFields = selection?.type === 'custom'
  const example = selection ? exampleModel(selection.provider) : null
  const isOllama = selection?.provider === 'ollama'
  const isCloudflare = selection?.provider === 'cloudflare'

  // Group options by provider for rendering with visual separators.
  const groupedOptions: { provider: string; items: typeof options }[] = []
  for (const opt of options) {
    const last = groupedOptions[groupedOptions.length - 1]
    if (last && last.provider === opt.provider) {
      last.items.push(opt)
    } else {
      groupedOptions.push({ provider: opt.provider, items: [opt] })
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="responsive-dialog overflow-y-auto p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          Add AI Model
        </Dialog.Title>

        <div className="space-y-4">
          {/* Model / Provider selection */}
          <Select
            label={gatewayMode ? 'Select Provider' : 'Select Model'}
            className="w-full text-sm"
            placeholder={gatewayMode ? 'Choose a provider...' : 'Choose an AI model...'}
            value={selectValue}
            // LOCAL PATCH: explicit direct-routing bypass for AI Gateway mode — remove when
            // fixed upstream. Base UI's Select emits `null` (not a string) when the currently
            // selected value falls out of the option list -- which the direct-routing toggle
            // can do, since it changes enabledProviders above. Guard rather than cast, or a
            // shrinking option list crashes decodeSelection() on a null.startsWith() call.
            onValueChange={(v) => { if (typeof v === 'string') handleModelSelect(v) }}
            error={errors.selection}
            renderValue={(v) => {
              const opt = options.find(o => o.value === v)
              return opt?.label ?? String(v)
            }}
          >
            {groupedOptions.map((group, groupIndex) => (
              <div key={group.provider}>
                {groupIndex > 0 && (
                  <div className="h-px bg-kumo-line my-1 mx-2" />
                )}
                <div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                  {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                </div>
                {group.items.map(opt => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </div>
            ))}
          </Select>

          {/* LOCAL PATCH: explicit direct-routing bypass for AI Gateway mode — remove when
              fixed upstream. Gated on gatewayMode only (not on a provider selection) because
              flipping it changes which providers the Select above offers. */}
          {gatewayMode && (
            <div>
              <Switch
                label="Route directly (bypass AI Gateway)"
                checked={directRouting}
                onCheckedChange={setDirectRouting}
              />
              <p className="text-xs text-kumo-subtle mt-1">
                Connect straight to this model's own API URL using its own credentials instead
                of routing through AI Gateway. Needed to reach a provider or endpoint behind an
                authenticating proxy, such as Cloudflare Access.
              </p>
            </div>
          )}

          {/* Custom model fields */}
          {showCustomFields && (
            <>
              <Input
                label="Model ID"
                placeholder={`e.g., ${example!.modelId}`}
                description={`The model identifier as specified by the provider (e.g., '${example!.modelId}')`}
                value={modelId}
                onChange={(e) => { setModelId(e.target.value); setErrors(prev => ({ ...prev, modelId: '' })) }}
                error={errors.modelId}
                variant={errors.modelId ? 'error' : 'default'}
              />

              <Input
                label="Display Name"
                placeholder={`e.g., ${example!.name}`}
                description="Human-readable name shown in the UI"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setErrors(prev => ({ ...prev, displayName: '' })) }}
                error={errors.displayName}
                variant={errors.displayName ? 'error' : 'default'}
              />
            </>
          )}

          {/* Cloudflare account ID (the Workers AI REST endpoint is account-scoped) */}
          {useDirectCredentials && isCloudflare && (
            <Input
              label="Cloudflare Account ID"
              placeholder="e.g., 0123456789abcdef0123456789abcdef"
              description="The Cloudflare account to bill for Workers AI usage"
              value={accountId}
              onChange={(e) => { setAccountId(e.target.value); setErrors(prev => ({ ...prev, accountId: '' })) }}
              error={errors.accountId}
              variant={errors.accountId ? 'error' : 'default'}
            />
          )}

          {/* API Token */}
          {useDirectCredentials && selection && (
            <SensitiveInput
              label="API Token"
              placeholder={API_TOKEN_PLACEHOLDERS[selection.provider]}
              description={
                isOllama
                  ? 'Optional for local Ollama access'
                  : isCloudflare
                  ? 'An API token with Workers AI Read + Edit permissions (in the dashboard: Workers AI > Use REST API > Create a Workers AI API Token)'
                  : `Your ${PROVIDER_LABELS[selection.provider]} API token for billing`
              }
              value={apiToken}
              onValueChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
              variant={errors.apiToken ? 'error' : 'default'}
            />
          )}

          {/* Ollama API URL (always visible for Ollama) */}
          {useDirectCredentials && isOllama && (
            <Input
              label="API URL"
              placeholder="http://localhost:11434"
              description="URL of your Ollama server"
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setErrors(prev => ({ ...prev, apiUrl: '' })) }}
              error={errors.apiUrl}
              variant={errors.apiUrl ? 'error' : 'default'}
            />
          )}

          {/* Advanced Settings for non-Ollama providers */}
          {/* LOCAL PATCH: dropped the !isCloudflare exclusion so Workers AI can use a custom
              API URL (e.g. an Access-protected proxy) — remove when fixed upstream */}
          {useDirectCredentials && selection && !isOllama && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>Advanced Settings</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <Input
                  label="API URL"
                  placeholder="https://..."
                  description="Override the default API endpoint (useful for proxies like Cloudflare AI Gateway)"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />

                {/* LOCAL PATCH: header injection for Access-protected endpoints — remove when fixed upstream */}
                <div className="mt-4">
                  <div className="text-sm font-medium mb-2">Extra headers</div>
                  <div className="text-xs text-kumo-subtle mb-2">
                    Extra HTTP headers sent with every request to this model's API — e.g. CF-Access-Client-Id
                    and CF-Access-Client-Secret for an endpoint behind Cloudflare Access.
                  </div>
                  {errors.headers && (
                    <p className="text-sm text-kumo-danger mb-2">{errors.headers}</p>
                  )}
                  {/* LOCAL PATCH: header injection for Access-protected endpoints — remove when
                      fixed upstream. Persistent column labels: a placeholder alone disappears
                      the instant a row has content, leaving no visual cue for which column is
                      which once both fields are filled -- see the aria-label on each input
                      below for the same fix on the accessible-name side. */}
                  {headerRows.length > 0 && (
                    <div className="flex gap-2 mb-1 text-xs text-kumo-subtle">
                      <div className="flex-1">Name</div>
                      <div className="flex-1">Value</div>
                      <div className="w-[88px]" />
                    </div>
                  )}
                  {headerRows.map((row, index) => (
                    <div key={index} className="flex gap-2 mb-2">
                      <Input
                        placeholder="Header name"
                        aria-label={`Header ${index + 1} name`}
                        value={row.name}
                        onChange={(e) => updateHeaderRow(index, { name: e.target.value })}
                        className="flex-1"
                      />
                      <SensitiveInput
                        placeholder="Header value"
                        aria-label={`Header ${index + 1} value`}
                        value={row.value}
                        onValueChange={(v) => updateHeaderRow(index, { value: v })}
                        className="flex-1"
                      />
                      <Button variant="secondary" onClick={() => removeHeaderRow(index)}>
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button variant="secondary" onClick={addHeaderRow}>
                    Add header
                  </Button>
                </div>
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props} disabled={loading}>
              Cancel
            </Button>
          )} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!selection}
          >
            Add Model
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
