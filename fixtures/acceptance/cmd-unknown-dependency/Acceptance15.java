package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance15 {
CommandPolicy policy; @GetMapping("/policy") void command(String q) throws Exception { Runtime.getRuntime().exec(policy.resolve(q)); }
}
