document.addEventListener("DOMContentLoaded", function () { const registerForm = document.getElementById("registerForm"); const whatsappNumberInput = document.getElementById("whatsappNumber"); const referralLinkDisplay = document.getElementById("referralLinkDisplay");

if (registerForm) {
    registerForm.addEventListener("submit", async function (e) {
        e.preventDefault();
        const whatsappNumber = whatsappNumberInput.value.trim();
        
        if (whatsappNumber === "") {
            alert("Please enter your WhatsApp number.");
            return;
        }

        try {
            const response = await fetch("/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ whatsappNumber })
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

