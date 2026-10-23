import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Statement;

// Static analysis fixture only. Tests read this file; they never compile or execute it.
class Demo {
    void audit(Statement statement, String input, Path path) throws Exception {
        statement.executeQuery("SELECT * FROM users WHERE name=" + input);
        Runtime.getRuntime().exec(input);
        Files.readString(path);
    }
}
