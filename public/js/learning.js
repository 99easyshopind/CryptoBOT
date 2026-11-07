const LearningUI = {
    data: null,
    async request(url, body) {
        const response = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Request failed');
        return data;
    },
    async action(action) { try { this.render(await this.request('/api/learning/' + action, {})); } catch (e) { App.showToast(e.message, 'error'); } },
    async load() { try { this.render(await this.request('/api/learning')); } catch (e) { App.showToast(e.message, 'error'); } },
    async update(action, all) {
        const ids = all ? this.data.learnings.filter(x => !x.implemented && !x.removedAt && x.symbol && x.strategy).map(x => x.id) : [...document.querySelectorAll('.learning-select:checked')].map(x => x.value);
        if (!ids.length) return App.showToast('Select learnings first', 'warning');
        if (action === 'implement' && !confirm('These experimental filters affect matching paper and live trades. Paper learning will start for forward observation. Implement?')) return;
        if (action === 'delete' && !confirm('Remove the selected implemented filters? Their history will remain visible.')) return;
        try { this.render(await this.request('/api/learning/' + action, { ids })); } catch (e) { App.showToast(e.message, 'error'); }
    },
    render(data) {
        const selected = new Set([...document.querySelectorAll('.learning-select:checked')].map(x => x.value));
        this.data = data;
        document.getElementById('learningStatus').textContent = `${data.running ? 'Learning running' : 'Learning stopped'}${data.error ? ' — ' + data.error : ''}. ${data.caveat}`;
        const list = document.getElementById('learningList'); list.replaceChildren();
        if (!data.learnings.length) list.textContent = 'No learnings yet. A losing simulated or eligible real trade can generate a proposed filter.';
        for (const rule of data.learnings) {
            const row = document.createElement('label'); row.className = 'learning-item';
            const box = document.createElement('input'); box.type = 'checkbox'; box.className = 'learning-select'; box.value = rule.id; box.checked = selected.has(rule.id); row.append(box);
            const content = document.createElement('span'); content.className = 'learning-item-content'; row.append(content);
            const results = rule.verification || [];
            const blocked = results.filter(r => r.blockedByRule);
            const retained = results.filter(r => !r.blockedByAny);
            const mean = values => values.length ? (values.reduce((a, b) => a + b.pnlPercent, 0) / values.length).toFixed(3) + '%' : 'n/a';
            const state = rule.implemented ? 'Implemented' : rule.removedAt ? 'Removed' : 'Proposed';
            const heading = document.createElement('span'); heading.className = 'learning-item-heading';
            const title = document.createElement('strong'); title.textContent = `${rule.symbol || 'Unscoped'} / ${rule.strategy || 'legacy'} · ${rule.side || 'signal'}`;
            const badge = document.createElement('span'); badge.className = 'soft-badge'; badge.textContent = state;
            heading.append(title, badge); content.append(heading);
            const evidence = document.createElement('span'); evidence.className = 'learning-item-evidence'; evidence.textContent = `${rule.source} learning · ${rule.evidence}`; content.append(evidence);
            const verification = document.createElement('span'); verification.className = 'learning-item-verification';
            verification.textContent = `Forward shadow: ${results.length} observations · ${blocked.length} blocked by this filter (mean hypothetical return ${mean(blocked)}) · ${retained.length} retained by all filters (mean ${mean(retained)}).`; content.append(verification);
            const history = (rule.history || []).map(x => `${x.action} ${x.at}`).join(', ');
            if (history) { const audit = document.createElement('span'); audit.className = 'learning-item-history'; audit.textContent = `History: ${history}`; content.append(audit); }
            list.append(row);
        }
        const trades = document.getElementById('paperTrades'); trades.replaceChildren();
        const title = document.createElement('p'); title.textContent = `Paper/shadow observations: ${data.trades.length} closed${data.open ? ', 1 open' : ''}. Blocked observations are hypothetical and not taken trades.`; trades.append(title);
        for (const t of [...data.trades].reverse()) {
            const row = document.createElement('p');
            row.textContent = `${new Date(t.closedAt).toLocaleString()} ${t.symbol || 'BTCUSD'} ${t.strategy} ${t.side} ${t.blocked ? '(blocked shadow)' : '(paper)'} ${t.entry} → ${t.exit}: ${t.pnl.toFixed(3)}%`;
            trades.append(row);
        }
    }
};
