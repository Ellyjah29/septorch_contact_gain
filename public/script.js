document.addEventListener("DOMContentLoaded", function () { const registerForm = document.getElementById("registerForm"); const whatsappNumberInput = document.getElementById("whatsappNumber"); const nameInput = document.createElement("input"); const emailInput = document.createElement("input"); const referralLinkDisplay = document.getElementById("referralLinkDisplay");

// Add Name and Email fields dynamically
nameInput.setAttribute("type", "text");
nameInput.setAttribute("id", "name");
nameInput.setAttribute("placeholder", "Your Name");
nameInput.required = true;

emailInput.setAttribute("type", "email");
emailInput.setAttribute("id", "email");
emailInput.setAttribute("placeholder", "Your Email");
emailInput.required = true;

registerForm.insertBefore(nameInput, whatsappNumberInput);
registerForm.insertBefore(emailInput, whatsappNumberInput.nextSibling);

if (registerForm) {
    registerForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        const name = nameInput.value.trim();
        const email = emailInput.value.trim();
        const whatsappNumber = whatsappNumberInput.value.trim();
        
        if (!name || !email || !whatsappNumber) {
            alert("Please fill in all fields.");
            return;
        }

        try {
            const response = await fetch("/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, email, whatsappNumber })
            });

            const data = await response.json();
            if (data.message === "User registered") {
                referralLinkDisplay.innerHTML = `<p>Your referral link: <a href="${data.referralLink}" target="_blank">${data.referralLink}</a></p>`;
            } else {
                alert("Error: " + data.message);
            }
        } catch (error) {
            console.error("Error registering user:", error);
            alert("Failed to register. Please try again later.");
        }
    });
}

});

