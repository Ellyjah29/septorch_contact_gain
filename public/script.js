document.addEventListener("DOMContentLoaded", function () { const registerForm = document.getElementById("registerForm"); const whatsappNumberInput = document.getElementById("whatsappNumber"); const referralLinkDisplay = document.getElementById("referralLinkDisplay");

// Create and insert Name and Email fields dynamically
const nameInput = document.createElement("input");
nameInput.type = "text";
nameInput.id = "name";
nameInput.placeholder = "Your Name";
nameInput.required = true;

const emailInput = document.createElement("input");
emailInput.type = "email";
emailInput.id = "email";
emailInput.placeholder = "Your Email";
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
            if (response.ok) {
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

