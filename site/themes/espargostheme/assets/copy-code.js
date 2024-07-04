document.addEventListener("DOMContentLoaded", () => {
	for (let elem of document.getElementsByTagName("pre")) {
		if (elem.textContent.includes("\n")) {
			let copycontainer = document.getElementById("code-copy-container-template").cloneNode(true);
			copycontainer.removeAttribute("id");
			copycontainer.hidden = false;
	
			copycontainer.appendChild(elem.cloneNode(true));
			elem.replaceWith(copycontainer);

			let badge = copycontainer.getElementsByClassName("code-copy-badge")[0];
			badge.addEventListener("click", () => {
				let code = elem.getElementsByTagName("code")[0].textContent;
				navigator.clipboard.writeText(code).then(() => {
					badge.getElementsByClassName("clipboard-ready")[0].hidden = true;
					badge.getElementsByClassName("clipboard-check")[0].hidden = false;
					setTimeout(() => {
						badge.getElementsByClassName("clipboard-ready")[0].hidden = false;
						badge.getElementsByClassName("clipboard-check")[0].hidden = true;
					}, 2000);
				});
			});
		}
	}
});