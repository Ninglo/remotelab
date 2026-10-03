async function renderChapters() {
  const response = await fetch(new URL('./project.json?v=20261003e', import.meta.url));
  if (!response.ok) throw new Error('项目目录暂时不可用');
  const project = await response.json();
  const articles = project.chapters.map(chapter => {
    const article = document.createElement('article');
    const heading = document.createElement('h3');
    const link = document.createElement('a');
    link.href = chapter.route;
    link.textContent = `${chapter.title} →`;
    heading.append(link);
    const description = document.createElement('p');
    description.textContent = chapter.description;
    article.append(heading, description);
    return article;
  });
  document.querySelector('#chapter-list').replaceChildren(...articles);
}

renderChapters().catch(() => {
  // The static chapter links remain readable when the catalog cannot load.
});
