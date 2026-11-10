package acceptance;
import java.sql.Statement;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.FileInputStream;
class Acceptance08 {
@GetMapping("/version") void version(String action) throws Exception { if(!"version".equals(action)) throw new IllegalArgumentException(); Runtime.getRuntime().exec(new String[]{"/usr/bin/java","-version"}); }
}
