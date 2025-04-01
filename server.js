<!DOCTYPE html><html lang="en"><head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Panel</title>
    <link rel="stylesheet" href="styles.css">
    <style>
        body {
            background: url('https://files.catbox.moe/s7xpty.jpg') no-repeat center center fixed;
            background-size: cover;
            font-family: Arial, sans-serif;
            color: white;
            text-align: center;
        }
        .container {
            background: rgba(0, 0, 0, 0.7);
            padding: 20px;
            border-radius: 10px;
            width: 80%;
            max-width: 800px;
            margin: 50px auto;
        }
        img.logo {
            width: 150px;
            display: block;
            margin: 0 auto 20px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
            background: rgba(255, 255, 255, 0.1);
        }
        table, th, td {
            border: 1px solid white;
        }
        th, td {
            padding: 10px;
            text-align: center;
        }
        .powered-by {
            margin-top: 20px;
            font-size: 14px;
            color: #bbb;
        }
        .login-container {
            background: rgba(0, 0, 0, 0.8);
            padding: 20px;
            border-radius: 10px;
            width: 300px;
            margin: 100px auto;
        }
        input, button {
            width: 100%;
            padding: 10px;
            margin: 10px 0;
            border: none;
            border-radius: 5px;
        }
        button {
            background: #007bff;
            color: white;
            cursor: pointer;
        }
        button:hover {
            background: #0056b3;
        }
    </style>
</head>
<body>
    <div id="loginSection" class="login-container">
        <h2>Admin Login</h2>
        <input type="password" id="adminPassword" placeholder="Enter Admin Password">
        <button onclick="checkLogin()">Login</button>
    </div><div id="adminPanel" class="container" style="display: none;">
    <img src="https://files.catbox.moe/mdeuf8.jpeg" alt="Logo" class="logo">
    <h1>Admin Panel</h1>
    <button onclick="loadUsers()">Load Users</button>
    <table>
        <thead>
            <tr>
                <th>Contact Name</th>
                <th>WhatsApp Number</th>
                <th>Referrals</th>
                <th>Joined Channel</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody id="userTableBody"></tbody>
    </table>
    <p class="powered-by">Powered by Septorch</p>
</div><script>
    let ADMIN_PASSWORD = "";

    function checkLogin() {
        const password = document.getElementById("adminPassword").value;
        ADMIN_PASSWORD = password;
        document.getElementById("loginSection").style.display = "none";
        document.getElementById("adminPanel").style.display = "block";
    }

    function loadUsers() {
        fetch('/api/getUsers', { headers: { 'x-admin-token': ADMIN_PASSWORD } })
            .then(response => response.json())
            .then(data => {
                let tableBody = document.getElementById("userTableBody");
                tableBody.innerHTML = "";
                data.forEach(user => {
                    let row = `<tr>
                        <td><input type='text' value='${user.name || "Unknown"}' id='name-${user.phone}'></td>
                        <td><input type='text' value='${user.phone}' id='phone-${user.phone}'></td>
                        <td>${user.referrals}</td>
                        <td>${user.joinedChannel ? "Yes" : "No"}</td>
                        <td>
                            <button onclick="editUser('${user.phone}')">Edit</button>
                            <button onclick="removeUser('${user.phone}')">Remove</button>
                        </td>
                    </tr>`;
                    tableBody.innerHTML += row;
                });
            });
    }

    function editUser(oldPhone) {
        const newName = document.getElementById(`name-${oldPhone}`).value;
        const newPhone = document.getElementById(`phone-${oldPhone}`).value;
        fetch('/api/editUser', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_PASSWORD },
            body: JSON.stringify({ oldPhone, newName, newPhone })
        }).then(() => loadUsers());
    }

    function removeUser(phone) {
        fetch('/api/removeUser', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_PASSWORD },
            body: JSON.stringify({ phone })
        }).then(() => loadUsers());
    }
</script></body>
</html>
