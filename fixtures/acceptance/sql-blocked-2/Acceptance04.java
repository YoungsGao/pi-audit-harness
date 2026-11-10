package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance04 {
Statement stmt; @GetMapping("/number") void number(String id) throws Exception { if(!id.matches("[0-9]{1,8}")) throw new IllegalArgumentException(); stmt.executeQuery("SELECT name FROM clients WHERE id="+id); }
}
