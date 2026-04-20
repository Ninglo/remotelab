(function initParentEnglishCoursewarePage(globalScope) {
  const previewContentByAudience = {
    direct: {
      label: '今晚陪练脚本',
      title: 'Can you bring a gift to the party?',
      body: '先看图说词，再跟读句子，最后让孩子自己回答 yes / no 和物品名称。',
      steps: [
        '先指着图说: gift, cake, balloon。',
        '家长问: Can you bring a gift to the party?',
        '孩子回答后，再追问: What gift can you bring?',
      ],
    },
    coach: {
      label: '课程目标自检',
      title: '孩子能不能脱离提示自己说完整句？',
      body: '先不看课件，观察孩子是否能根据 party 场景独立调用词汇和句型。',
      steps: [
        '请孩子看图，用完整句说出自己能带什么去 party。',
        '追问: Why can you bring it? 看孩子是否能扩展原因。',
        '最后核对: 是否混淆 bring / have，是否漏掉冠词。',
      ],
    },
  };

  function $(selector) {
    return globalScope.document.querySelector(selector);
  }

  function $all(selector) {
    return Array.from(globalScope.document.querySelectorAll(selector));
  }

  function renderPreview(mode) {
    const previewBody = $('#previewBody');
    const preview = previewContentByAudience[mode];
    if (!previewBody || !preview) return;

    const stepsMarkup = preview.steps.map((step) => `<li>${step}</li>`).join('');
    previewBody.innerHTML = [
      `<p class="preview-label">${preview.label}</p>`,
      `<h3>${preview.title}</h3>`,
      `<p>${preview.body}</p>`,
      `<ol>${stepsMarkup}</ol>`,
    ].join('');
  }

  function selectAudience(mode) {
    $all('[data-audience-tab]').forEach((tab) => {
      const isActive = tab.getAttribute('data-audience-tab') === mode;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    $all('[data-audience-panel]').forEach((panel) => {
      const isMatch = panel.getAttribute('data-audience-panel') === mode;
      panel.classList.toggle('is-hidden', !isMatch);
    });

    renderPreview(mode);
  }

  function bindAudienceTabs() {
    $all('[data-audience-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const mode = tab.getAttribute('data-audience-tab');
        if (mode) selectAudience(mode);
      });
    });
  }

  if (!globalScope.document) return;
  bindAudienceTabs();
  selectAudience('direct');
})(window);
