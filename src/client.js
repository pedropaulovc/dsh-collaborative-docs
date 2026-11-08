window.__ModuleLoader__.load({
  id: '@pedropaulovc/dsh-collaborative-docs',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        function DocumentsPanel() {
          const [url, setUrl] = React.useState('')
          const [error, setError] = React.useState('')
          const [busy, setBusy] = React.useState(false)
          const controller = React.useRef(null)
          React.useEffect(() => () => controller.current?.abort(), [])
          async function prepare() {
            controller.current?.abort()
            const current = new AbortController()
            controller.current = current
            setBusy(true)
            setError('')
            try {
              const result = await ctx.connection.rpc.call('/api', 'collaborative_docs_open', {}, current.signal)
              if (!result.ok) throw new Error(result.error.message)
              if (!result.value || typeof result.value.url !== 'string') throw new Error('The host returned no editor URL.')
              const target = new URL(result.value.url)
              if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.searchParams.get('token')) throw new Error('The host returned an invalid local editor URL.')
              if (!current.signal.aborted) setUrl(target.href)
            } catch (failure) {
              if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : 'Unable to start documents.')
            } finally {
              if (!current.signal.aborted) setBusy(false)
            }
          }
          return h('section', { style: { padding: '24px', maxWidth: '640px', fontFamily: 'inherit' } },
            h('h1', null, 'Documents'),
            h('p', null, 'Edit local documents together with the agent, including native comment threads. Documents stay on this computer.'),
            h('button', { type: 'button', disabled: busy, onClick: prepare }, busy ? 'Starting editor…' : url ? 'Refresh editor link' : 'Prepare local editor'),
            url && h('p', null, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open documents in your browser')),
            url && h('p', null, 'This private link grants access to your local documents. Do not share it.'),
            error && h('p', { role: 'alert' }, `${error} Try preparing the editor again.`),
          )
        }
        function DocumentsIcon({ size = 20 }) {
          return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true },
            h('path', { d: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6' }))
        }
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'collaborative-docs' }, DocumentsPanel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'collaborative-docs', label: 'Documents', order: 50 }, DocumentsIcon))
      },
    }
  },
})
