package audit.demo;

import java.sql.Statement;

class UserRepository {
    Statement statement;

    String query(String input) {
        statement.executeQuery("SELECT * FROM users WHERE name=" + input);
        return input;
    }
}
